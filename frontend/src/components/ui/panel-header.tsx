import type { ReactNode } from "react";

export type PanelHeaderProps = {
  eyebrow: string;
  title: ReactNode;
  actions?: ReactNode;
};

/** Shared heading row for dashboard panels: eyebrow, title, and an optional action slot. */
export function PanelHeader({ eyebrow, title, actions }: PanelHeaderProps) {
  return (
    <div className="panel-head">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h2>{title}</h2>
      </div>
      {actions}
    </div>
  );
}
