/**
 * Minimal next/link stand-in for the CTR-104 browser fixture. The real
 * Next Link renders an anchor with client-side navigation; the fixture
 * only needs the anchor and its href, because the Council chamber form is
 * a NATIVE GET form and never relies on the Next router.
 */
import type { AnchorHTMLAttributes, ReactNode } from 'react';

export default function Link({
  href,
  children,
  ...rest
}: { href: string; children?: ReactNode } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a href={href} {...rest}>
      {children}
    </a>
  );
}
