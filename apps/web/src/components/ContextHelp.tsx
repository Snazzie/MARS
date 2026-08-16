type ContextHelpProps = { label: string; children: string };

export function ContextHelp({ label, children }: ContextHelpProps) {
  return <details className="context-help"><summary>{label}</summary><p>{children}</p></details>;
}
