// Authentication may only return to a route within this application.
export function safeReturnTo(value: string | null | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u0020]/.test(value))
    return '/';
  try {
    const target = new URL(value, 'https://vidyalayaa.invalid');
    if (
      target.origin !== 'https://vidyalayaa.invalid' ||
      /^\/(auth|login)(\/|$)/.test(target.pathname)
    )
      return '/';
    return target.pathname + target.search + target.hash;
  } catch {
    return '/';
  }
}
