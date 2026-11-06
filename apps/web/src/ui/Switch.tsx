/** An on/off switch (`role="switch"`): the label says what it shows, the state is `aria-checked`. */
export function Switch({ label, checked, onChange }: { label: string; checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={checked} className="switch" onClick={() => onChange(!checked)}>
      <span className="switch-track" aria-hidden="true">
        <span className="switch-thumb" />
      </span>
      <span>{label}</span>
    </button>
  );
}
