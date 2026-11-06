import { useEffect, useRef, type ReactNode } from 'react';
import { CircleCheck, CircleX, Info, TriangleAlert, type LucideIcon } from 'lucide-react';

export type NoticeKind = 'info' | 'warn' | 'error' | 'success';

const ICONS: Record<NoticeKind, LucideIcon> = {
  info: Info,
  warn: TriangleAlert,
  error: CircleX,
  success: CircleCheck,
};

/**
 * Notice: title, body and at most two actions. Errors use role="alert", the others
 * role="status". Never auto-dismisses. `focus` moves keyboard focus to the title
 * when the notice appears (used for the final state of a capture).
 */
export function Notice({
  kind,
  title,
  children,
  actions,
  focus = false,
}: {
  kind: NoticeKind;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
  focus?: boolean;
}) {
  const Icon = ICONS[kind];
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focus) titleRef.current?.focus();
  }, [focus]);
  return (
    <div className={`notice notice-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <Icon size={20} strokeWidth={1.75} aria-hidden="true" className="notice-icon" />
      <div className="notice-content">
        <h3 className="notice-title" ref={titleRef} tabIndex={-1}>
          {title}
        </h3>
        {children ? <div className="notice-body">{children}</div> : null}
        {actions ? <div className="notice-actions">{actions}</div> : null}
      </div>
    </div>
  );
}
