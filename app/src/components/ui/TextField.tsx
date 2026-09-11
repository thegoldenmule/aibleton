export interface FieldProps {
  id: string;
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  inputMode?: "numeric" | "decimal";
}

/** One labelled input in a generator form. The template and band generators share it. */
export function TextField({ id, label, hint, value, onChange, placeholder, inputMode }: FieldProps) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-[10px] uppercase tracking-wider text-muted">
        {label}
        {hint ? <span className="ml-1 normal-case text-muted/60">{hint}</span> : null}
      </label>
      <input
        id={id}
        value={value}
        inputMode={inputMode}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-sm border border-line bg-panel-2 px-2 py-1 font-mono text-xs outline-none placeholder:text-muted/50 focus:border-accent"
      />
    </div>
  );
}
