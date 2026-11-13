import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type EmptyStateProps = {
  icon?: ReactNode;
  title?: ReactNode;
  className?: string;
  children?: ReactNode;
};

/** Shared empty-state block used by lists, picture galleries, and workspace panes. */
export function EmptyState({ icon, title, className, children }: EmptyStateProps) {
  return (
    <div className={cn("empty", className)}>
      {icon ? <span>{icon}</span> : null}
      {title ? <b>{title}</b> : null}
      {children ? <p>{children}</p> : null}
    </div>
  );
}
