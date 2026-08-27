use std::env;
use std::ffi::OsString;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::os::windows::io::AsRawHandle;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use windows_service::define_windows_service;
use windows_service::service::{
    ServiceControl, ServiceControlAccept, ServiceExitCode, ServiceState, ServiceStatus, ServiceType,
};
use windows_service::service_control_handler::{self, ServiceControlHandlerResult};
use windows_service::service_dispatcher;
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, QueryInformationJobObject, SetInformationJobObject,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectBasicAccountingInformation,
    JobObjectExtendedLimitInformation, TerminateJobObject,
};
use windows_sys::Win32::System::Threading::GetCurrentProcessId;

const SERVICE_NAME: &str = "MarsWorker";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TerminationCause {
    ChildExit,
    ServiceStop,
    ForcedJobTermination,
    ChildDisappeared,
    ServiceHostError,
}

impl TerminationCause {
    fn as_str(self) -> &'static str {
        match self {
            Self::ChildExit => "child_exit",
            Self::ServiceStop => "service_stop",
            Self::ForcedJobTermination => "forced_job_termination",
            Self::ChildDisappeared => "child_disappeared",
            Self::ServiceHostError => "service_host_error",
        }
    }
}

#[derive(Clone, Copy, Debug, Default)]
struct JobAccounting {
    active_process_count: u32,
    total_process_count: u32,
    peak_process_count: u32,
    peak_process_memory_bytes: u64,
    peak_job_memory_bytes: u64,
    kernel_time_100ns: u64,
    user_time_100ns: u64,
}

#[derive(Clone, Copy, Debug)]
struct SupervisionOutcome {
    exit_code: u32,
    cause: TerminationCause,
    exit_observed: bool,
    elapsed_ms: u64,
    accounting: Option<JobAccounting>,
}

fn json_escape(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"").replace('\r', "\\r").replace('\n', "\\n")
}

fn now_iso() -> String {
    let seconds = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    format!("{seconds}")
}

fn append_record(event: &str, child_pid: Option<u32>, cause: Option<TerminationCause>, message: Option<&str>, accounting: Option<JobAccounting>) {
    let path = log_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let accounting_json = accounting.map_or_else(|| "null".to_owned(), |value| format!(
        "{{\"activeProcessCount\":{},\"totalProcessCount\":{},\"peakProcessCount\":{},\"peakProcessMemoryBytes\":{},\"peakJobMemoryBytes\":{},\"kernelTime100ns\":{},\"userTime100ns\":{}}}",
        value.active_process_count, value.total_process_count, value.peak_process_count, value.peak_process_memory_bytes,
        value.peak_job_memory_bytes, value.kernel_time_100ns, value.user_time_100ns,
    ));
    let cause_json = cause.map_or_else(|| "null".to_owned(), |value| format!("\"{}\"", value.as_str()));
    let child_json = child_pid.map_or_else(|| "null".to_owned(), |value| value.to_string());
    let message_json = message.map_or_else(|| "null".to_owned(), |value| format!("\"{}\"", json_escape(value)));
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{{\"timestamp\":\"{}\",\"event\":\"{}\",\"servicePid\":{},\"childPid\":{},\"cause\":{},\"message\":{},\"accounting\":{}}}", now_iso(), event, unsafe { GetCurrentProcessId() }, child_json, cause_json, message_json, accounting_json);
        let _ = file.flush();
    }
}
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
    fn accounting(&self) -> io::Result<JobAccounting> {
        let mut extended: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        let mut returned = 0u32;
        let ok = unsafe {
            QueryInformationJobObject(
                self.0,
                JobObjectExtendedLimitInformation,
                (&mut extended as *mut JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                &mut returned,
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut basic: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { std::mem::zeroed() };
        let ok = unsafe {
            QueryInformationJobObject(
                self.0,
                JobObjectBasicAccountingInformation,
                (&mut basic as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                std::mem::size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                &mut returned,
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(JobAccounting {
            active_process_count: basic.ActiveProcesses,
            total_process_count: basic.TotalProcesses,
            peak_process_count: basic.TotalProcesses,
            peak_process_memory_bytes: extended.PeakProcessMemoryUsed as u64,
            peak_job_memory_bytes: extended.PeakJobMemoryUsed as u64,
            kernel_time_100ns: basic.TotalKernelTime as u64,
            user_time_100ns: basic.TotalUserTime as u64,
        })
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
        .join("Mars")
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
    append_record("child_spawned", Some(child.id()), None, Some(executable.to_string_lossy().as_ref()), None);
    let job = Job::new()?;
    if let Err(error) = job.assign(&child) {
        let _ = child.kill();
        append_record("service_host_error", Some(child.id()), Some(TerminationCause::ServiceHostError), Some(&error.to_string()), None);
        return Err(error);
    }
    append_record("job_assigned", Some(child.id()), None, None, job.accounting().ok());
    Ok((child, job))
}

#[allow(clippy::too_many_arguments)]
fn supervise_child(
    mut child: Child,
    job: Job,
    stop: mpsc::Receiver<()>,
    on_stop: impl FnOnce() -> io::Result<()>,
) -> io::Result<SupervisionOutcome> {
    let started = Instant::now();
    let child_pid = child.id();
    let mut on_stop = Some(on_stop);
    loop {
        if stop.try_recv().is_ok() {
            append_record("service_stop_requested", Some(child_pid), Some(TerminationCause::ServiceStop), None, job.accounting().ok());
            if let Some(report) = on_stop.take() {
                report()?;
            }
            let accounting = job.accounting().ok();
            job.terminate();
            let status = child.wait().ok();
            let outcome = SupervisionOutcome {
                exit_code: 0,
                cause: TerminationCause::ServiceStop,
                exit_observed: status.is_some(),
                elapsed_ms: started.elapsed().as_millis() as u64,
                accounting,
            };
            append_record("job_terminated", Some(child_pid), Some(outcome.cause), None, outcome.accounting);
            return Ok(outcome);
        }
        if let Some(status) = child.try_wait()? {
            let outcome = SupervisionOutcome {
                exit_code: if status.success() { 1 } else { child_exit_code(status) },
                cause: TerminationCause::ChildExit,
                exit_observed: true,
                elapsed_ms: started.elapsed().as_millis() as u64,
                accounting: job.accounting().ok(),
            };
            append_record("child_exited", Some(child_pid), Some(outcome.cause), None, outcome.accounting);
            return Ok(outcome);
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
        let _ = writeln!(file, "Mars service host failed: {error}");
    }
}

fn service_main(_arguments: Vec<OsString>) {
    let arguments = env::args_os().skip(1).collect();
    if let Err(error) = run_service(arguments) {
        log_host_error(error.as_ref());
    }
}

fn run_service(arguments: Vec<OsString>) -> Result<(), Box<dyn std::error::Error>> {
    append_record("service_started", None, None, None, None);
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
    let outcome = supervise_child(child, job, stop_rx, || {
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
        outcome.exit_code,
        0,
        Duration::ZERO,
    ))?;
    Ok(())
}

fn console_smoke(args: Vec<OsString>) -> Result<u32, Box<dyn std::error::Error>> {
    append_record("service_started", None, None, None, None);
    let (executable, child_args) = worker_command(&args)?;
    let (child, job) = spawn_worker(&executable, &child_args)?;
    let (_tx, rx) = mpsc::channel();
    Ok(supervise_child(child, job, rx, || Ok(()))?.exit_code)
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

    #[test]
    fn forced_termination_is_not_oom() {
        let outcome = SupervisionOutcome {
            exit_code: 1,
            cause: TerminationCause::ForcedJobTermination,
            exit_observed: false,
            elapsed_ms: 1_000,
            accounting: None,
        };
        assert_eq!(outcome.cause, TerminationCause::ForcedJobTermination);
        assert!(!outcome.exit_observed);
    }

    #[test]
    fn records_escape_controlled_strings_and_preserve_unavailable_accounting() {
        let json = format!(
            "{{\"message\":\"{}\",\"accounting\":null}}",
            json_escape("worker\nfailed")
        );
        assert!(json.contains("worker\\nfailed"));
        assert!(json.contains("\"accounting\":null"));
    }
}
