"use client";

import type { ComponentType } from "react";
import { API } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import {
  LuActivity,
  LuBell,
  LuChartLine,
  LuFileText,
  LuPanelLeftClose,
  LuPenTool,
  LuPlus,
  LuServer,
  LuBookOpen,
} from "react-icons/lu";

type NavItem = {
  title: string;
  href: string;
  icon: ComponentType<{ className?: string }>;
  external?: boolean;
  section?: string;
};

type Props = {
  collapsed: boolean;
  mobileOpen: boolean;
  activeSection: string;
  activeAlerts: number;
  triggers: number;
  onNavigate: () => void;
  onCloseMobile: () => void;
  onToggleCollapsed: () => void;
};

const workspaceNav: NavItem[] = [
  { title: "Market chart", href: "#market", icon: LuChartLine, section: "market" },
  { title: "Create alert", href: "#create-alert", icon: LuPlus, section: "create-alert" },
  { title: "Your alerts", href: "#alerts", icon: LuBell, section: "alerts" },
  { title: "Activity", href: "#activity", icon: LuActivity, section: "activity" },
  { title: "Annotate", href: "#annotate", icon: LuPenTool, section: "annotate" },
];

const toolsNav: NavItem[] = [
  { title: "Alert report", href: "/report", icon: LuFileText },
  { title: "API docs", href: `${API}/docs/`, icon: LuBookOpen, external: true },
  { title: "API health", href: `${API}/health/`, icon: LuServer, external: true },
];

function NavLink({
  item,
  active,
  collapsed,
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  collapsed: boolean;
  onNavigate: () => void;
}) {
  const Icon = item.icon;
  return (
    <a
      href={item.href}
      title={collapsed ? item.title : undefined}
      aria-current={active ? "page" : undefined}
      target={item.external ? "_blank" : undefined}
      rel={item.external ? "noreferrer" : undefined}
      onClick={onNavigate}
      className={cn(
        "group flex h-9 items-center gap-3 rounded-md px-3 text-sm font-medium text-sidebar-foreground/75 outline-none transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring",
        active && "bg-sidebar-accent text-sidebar-accent-foreground",
        collapsed && "justify-center px-0",
      )}
    >
      <Icon className="size-4 shrink-0" />
      <span className={cn("truncate", collapsed && "hidden")}>{item.title}</span>
    </a>
  );
}

function SidebarBody({
  collapsed,
  activeSection,
  activeAlerts,
  triggers,
  onNavigate,
  onToggleCollapsed,
}: Omit<Props, "mobileOpen" | "onCloseMobile">) {
  return (
    <div className="flex h-full flex-col">
      <div
        className={cn(
          "flex h-14 shrink-0 items-center border-b border-sidebar-border px-3",
          collapsed ? "justify-center" : "gap-3",
        )}
      >
        <a
          href="#main-content"
          onClick={onNavigate}
          className="flex min-w-0 items-center gap-2.5"
          aria-label="Marketa+ home"
        >
          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
            <LuChartLine className="size-4" />
          </span>
          <span className={cn("min-w-0", collapsed && "hidden")}>
            <span className="block truncate text-sm font-semibold leading-tight tracking-tight text-sidebar-accent-foreground">
              Marketa+
            </span>
            <span className="block truncate text-[11px] leading-tight text-muted-foreground">
              Market analysis
            </span>
          </span>
        </a>
      </div>

      <nav className="flex-1 overflow-y-auto overflow-x-hidden px-2 py-3">
        <p
          className={cn(
            "mb-1 px-3 text-[11px] font-medium text-muted-foreground",
            collapsed && "px-0 text-center",
          )}
        >
          {collapsed ? "•" : "Workspace"}
        </p>
        <div className="grid gap-0.5">
          {workspaceNav.map((item) => (
            <NavLink
              key={item.title}
              item={item}
              active={activeSection === item.section}
              collapsed={collapsed}
              onNavigate={onNavigate}
            />
          ))}
        </div>

        <p
          className={cn(
            "mb-1 mt-5 px-3 text-[11px] font-medium text-muted-foreground",
            collapsed && "px-0 text-center",
          )}
        >
          {collapsed ? "•" : "Tools"}
        </p>
        <div className="grid gap-0.5">
          {toolsNav.map((item) => (
            <NavLink
              key={item.title}
              item={item}
              active={false}
              collapsed={collapsed}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      </nav>

      <div className="border-t border-sidebar-border p-2">
        <a
          href={`${API}/health/`}
          target="_blank"
          rel="noreferrer"
          title={collapsed ? "API status" : undefined}
          className={cn(
            "flex items-center gap-3 rounded-lg border border-sidebar-border bg-card px-3 py-2.5 text-xs shadow-sm transition-colors hover:bg-sidebar-accent",
            collapsed && "justify-center px-0",
          )}
        >
          <span className="relative flex size-2 shrink-0">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500/60" />
            <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
          </span>
          <span className={cn("min-w-0 flex-1", collapsed && "hidden")}>
            <span className="block font-medium leading-tight">API status</span>
            <span className="block truncate text-[11px] leading-tight text-muted-foreground">
              {activeAlerts} active · {triggers} triggers
            </span>
          </span>
        </a>
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className={cn(
            "mt-1 flex h-8 w-full items-center gap-3 rounded-md px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
            collapsed && "justify-center px-0",
          )}
        >
          <LuPanelLeftClose
            className={cn("size-4 shrink-0 transition-transform", collapsed && "rotate-180")}
          />
          <span className={cn(collapsed && "hidden")}>Collapse sidebar</span>
        </button>
      </div>
    </div>
  );
}

export default function AppSidebar(props: Props) {
  const { collapsed, mobileOpen, onCloseMobile, onNavigate, ...rest } = props;

  return (
    <>
      <aside
        className={cn(
          "sticky top-0 z-30 hidden h-svh shrink-0 border-r border-sidebar-border bg-sidebar transition-[width] duration-200 lg:flex lg:flex-col",
          collapsed ? "w-[68px]" : "w-64",
        )}
      >
        <SidebarBody
          collapsed={collapsed}
          onNavigate={onNavigate}
          {...rest}
        />
      </aside>

      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            aria-label="Close navigation"
            onClick={onCloseMobile}
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
          />
          <div className="absolute inset-y-0 left-0 w-72 border-r border-sidebar-border bg-sidebar shadow-xl">
            <SidebarBody
              collapsed={false}
              onNavigate={() => {
                onNavigate();
                onCloseMobile();
              }}
              {...rest}
            />
          </div>
        </div>
      )}
    </>
  );
}
