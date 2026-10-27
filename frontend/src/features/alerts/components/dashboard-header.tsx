import { API } from "@/lib/api/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  LuBell,
  LuChevronRight,
  LuMenu,
  LuMoon,
  LuPanelLeft,
  LuSun,
  LuZap,
} from "react-icons/lu";

type Props = {
  theme: "light" | "dark";
  activeAlerts: number;
  triggers: number;
  sidebarCollapsed: boolean;
  onToggleTheme: () => void;
  onToggleSidebar: () => void;
  onOpenMobileNav: () => void;
};

export default function DashboardHeader({
  theme,
  activeAlerts,
  triggers,
  sidebarCollapsed,
  onToggleTheme,
  onToggleSidebar,
  onOpenMobileNav,
}: Props) {
  const nextTheme = theme === "dark" ? "light" : "dark";

  return (
    <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center justify-between gap-2 border-b bg-background/80 px-4 backdrop-blur-md md:px-6">
      <div className="flex min-w-0 items-center gap-2">
        <Button
          variant="ghost"
          size="icon"
          className="size-8 lg:hidden"
          aria-label="Open navigation"
          onClick={onOpenMobileNav}
        >
          <LuMenu className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="hidden size-8 lg:inline-flex"
          aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={onToggleSidebar}
        >
          <LuPanelLeft className="size-4" />
        </Button>
        <Separator orientation="vertical" className="mr-1 hidden h-4 sm:block" />
        <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-sm">
          <span className="hidden text-muted-foreground sm:inline">Dashboard</span>
          <LuChevronRight className="hidden size-3.5 text-muted-foreground/70 sm:inline" />
          <span className="truncate font-medium text-foreground">Overview</span>
        </nav>
      </div>

      <div className="flex items-center gap-1.5">
        <a
          href={`${API}/health/`}
          target="_blank"
          rel="noreferrer"
          className="hidden items-center gap-2 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground sm:flex"
        >
          <span className="relative flex size-2">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500/60" />
            <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
          </span>
          API status
        </a>

        <Badge variant="secondary" className="gap-1.5 px-2 py-1" title="Active alerts">
          <LuBell className="size-3.5 text-amber-600 dark:text-amber-400" />
          <span className="font-mono tabular-nums">{activeAlerts.toString().padStart(2, "0")}</span>
          <span className="hidden text-muted-foreground md:inline">active</span>
        </Badge>

        <Badge variant="secondary" className="gap-1.5 px-2 py-1" title="Triggered events">
          <LuZap className="size-3.5 text-muted-foreground" />
          <span className="font-mono tabular-nums">{triggers.toString().padStart(2, "0")}</span>
          <span className="hidden text-muted-foreground md:inline">triggers</span>
        </Badge>

        <Separator orientation="vertical" className="mx-1 h-4" />

        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          aria-label={`Switch to ${nextTheme} mode`}
          title={`Switch to ${nextTheme} mode`}
          onClick={onToggleTheme}
        >
          {theme === "dark" ? <LuSun className="size-4" /> : <LuMoon className="size-4" />}
        </Button>

        <span
          className="grid size-8 shrink-0 place-items-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground"
          aria-hidden="true"
        >
          M+
        </span>
      </div>
    </header>
  );
}
