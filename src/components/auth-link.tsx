import type { ComponentProps, ReactNode } from "react";
import Link from "next/link";

type AuthLinkProps = Omit<ComponentProps<typeof Link>, "className"> & {
  children: ReactNode;
};

/**
 * Small quiet link used on the auth cards ("Forgot password?", "Back to sign
 * in"). Not a Client Component on its own, so it renders on the server inside
 * a page and in the bundle inside a form.
 *
 * Hover/focus colour is the accent blue (`accentBlue` in
 * `@/lib/theme/colors`), hardcoded here since Tailwind arbitrary values need a
 * literal, not an import.
 */
export default function AuthLink({ children, ...props }: AuthLinkProps) {
  return (
    <Link
      {...props}
      className="text-sm text-[#595959] underline-offset-4 transition-colors hover:text-[#007AFF] hover:underline focus-visible:text-[#007AFF] focus-visible:underline"
    >
      {children}
    </Link>
  );
}
