import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type NoticeProps = {
  tone?: "status" | "alert" | "stale";
  className?: string;
  children: ReactNode;
};

const toneClass = {
  status: "watch-notice",
  alert: "notice",
  stale: "watch-stale",
} as const;

/** Shared inline message used for refresh failures, saved-picture notices, and warnings. */
export function Notice({ tone = "status", className, children }: NoticeProps) {
  return (
    <p className={cn(toneClass[tone], className)} role={tone === "alert" ? "alert" : "status"}>
      {children}
    </p>
  );
}
