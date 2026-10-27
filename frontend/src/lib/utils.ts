type ClassValue = string | number | false | null | undefined;

/** Small class-name joiner, the same role `cn` plays in shadcn/ui. */
export function cn(...classes: ClassValue[]) {
  return classes.filter(Boolean).join(" ");
}
