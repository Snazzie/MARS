use std::env;
use std::ffi::OsString;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::os::windows::io::AsRawHandle;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::time::Duration;
use windows_service::define_windows_service;
use windows_service::service::{
    ServiceControl, ServiceControlAccept, ServiceExitCode, ServiceState, ServiceStatus, ServiceType,
};
use windows_service::service_control_handler::{self, ServiceControlHandlerResult};
use windows_service::service_dispatcher;
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject,
};

const SERVICE_NAME: &str = "WhitesmithWorker";
define_windows_service!(ffi_service_main, service_main);

struct Job(HANDLE);

impl Job {
    fn new() -> io::Result<Self> {
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let ok = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of_val(&info) as u32,
            )
        };
        if ok == 0 {
            unsafe { CloseHandle(handle) };
            return Err(io::Error::last_os_error());
        }
        Ok(Self(handle))
    }

    fn assign(&self, child: &Child) -> io::Result<()> {
        let ok = unsafe { AssignProcessToJobObject(self.0, child.as_raw_handle() as HANDLE) };
        if ok == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }

    fn terminate(&self) {
        unsafe {
            TerminateJobObject(self.0, 1);
        }
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

fn child_exit_code(status: ExitStatus) -> u32 {
    status.code().unwrap_or(1).max(1) as u32
}

fn worker_command(args: &[OsString]) -> io::Result<(PathBuf, Vec<OsString>)> {
    let executable = args.first().map(PathBuf::from).ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "orchestrator path is required")
    })?;
    if !executable.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "orchestrator path must be absolute",
        ));
    }
    if !executable.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("orchestrator not found: {}", executable.display()),
        ));
    }
    Ok((executable, args[1..].to_vec()))
}

fn log_path() -> PathBuf {
    PathBuf::from(env::var_os("ProgramData").unwrap_or_else(|| OsString::from(r"C:\ProgramData")))
        .join("Whitesmith")
        .join("logs")
        .join("worker.log")
}

fn spawn_worker(executable: &Path, args: &[OsString]) -> io::Result<(Child, Job)> {
    let log = log_path();
    if let Some(parent) = log.parent() {
        fs::create_dir_all(parent)?;
    }
    let stdout = OpenOptions::new().create(true).append(true).open(&log)?;
    let stderr = stdout.try_clone()?;
    let mut child = Command::new(executable)
        .args(args)
        .stdin(Stdio::null())
        .stdout(stdout)
        .stderr(stderr)
        .spawn()?;
    let job = Job::new()?;
    if let Err(error) = job.assign(&child) {
        let _ = child.kill();
        return Err(error);
    }
    Ok((child, job))
}

fn supervise_child(
    mut child: Child,
    job: Job,
    stop: mpsc::Receiver<()>,
    on_stop: impl FnOnce() -> io::Result<()>,
) -> io::Result<u32> {
    let mut on_stop = Some(on_stop);
    loop {
        if stop.try_recv().is_ok() {
            if let Some(report) = on_stop.take() {
                report()?;
            }
            job.terminate();
            let _ = child.wait();
            return Ok(0);
        }
        if let Some(status) = child.try_wait()? {
            return Ok(if status.success() {
                1
            } else {
                child_exit_code(status)
            });
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

fn status(
    state: ServiceState,
    accepted: ServiceControlAccept,
    exit: u32,
    checkpoint: u32,
    wait_hint: Duration,
) -> ServiceStatus {
    ServiceStatus {
        service_type: ServiceType::OWN_PROCESS,
        current_state: state,
        controls_accepted: accepted,
        exit_code: if exit == 0 {
            ServiceExitCode::Win32(0)
        } else {
            ServiceExitCode::ServiceSpecific(exit)
        },
        checkpoint,
        wait_hint,
        process_id: None,
    }
}

fn log_host_error(error: &dyn std::fmt::Display) {
    let path = log_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "Whitesmith service host failed: {error}");
    }
}

fn service_main(_arguments: Vec<OsString>) {
    let arguments = env::args_os().skip(1).collect();
    if let Err(error) = run_service(arguments) {
        log_host_error(error.as_ref());
    }
}

fn run_service(arguments: Vec<OsString>) -> Result<(), Box<dyn std::error::Error>> {
    let (stop_tx, stop_rx) = mpsc::channel();
    let handler = service_control_handler::register(SERVICE_NAME, move |control| match control {
        ServiceControl::Stop | ServiceControl::Shutdown => {
            let _ = stop_tx.send(());
            ServiceControlHandlerResult::NoError
        }
        ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
        _ => ServiceControlHandlerResult::NotImplemented,
    })?;
    handler.set_service_status(status(
        ServiceState::StartPending,
        ServiceControlAccept::empty(),
        0,
        1,
        Duration::from_secs(10),
    ))?;
    let (executable, child_args) = worker_command(&arguments)?;
    let (child, job) = spawn_worker(&executable, &child_args)?;
    handler.set_service_status(status(
        ServiceState::Running,
        ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN,
        0,
        0,
        Duration::ZERO,
    ))?;
    let exit = supervise_child(child, job, stop_rx, || {
        handler
            .set_service_status(status(
                ServiceState::StopPending,
                ServiceControlAccept::empty(),
                0,
                1,
                Duration::from_secs(10),
            ))
            .map_err(io::Error::other)
    })?;
    handler.set_service_status(status(
        ServiceState::Stopped,
        ServiceControlAccept::empty(),
        exit,
        0,
        Duration::ZERO,
    ))?;
    Ok(())
}

fn console_smoke(args: Vec<OsString>) -> Result<u32, Box<dyn std::error::Error>> {
    let (executable, child_args) = worker_command(&args)?;
    let (child, job) = spawn_worker(&executable, &child_args)?;
    let (_tx, rx) = mpsc::channel();
    Ok(supervise_child(child, job, rx, || Ok(()))?)
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = env::args_os().skip(1).collect::<Vec<_>>();
    if args.first().is_some_and(|arg| arg == "--console-smoke") {
        args.remove(0);
        std::process::exit(console_smoke(args)? as i32);
    }
    service_dispatcher::start(SERVICE_NAME, ffi_service_main)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn successful_child_exit_is_a_service_failure() {
        let status = Command::new("cmd.exe")
            .args(["/d", "/c", "exit 0"])
            .status()
            .unwrap();
        assert_eq!(
            if status.success() {
                1
            } else {
                child_exit_code(status)
            },
            1
        );
    }
}
