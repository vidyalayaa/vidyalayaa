import type { Role } from '@vidyalayaa/contracts';
export const portals: Record<Role, string> = {
  school_admin: 'admin',
  principal: 'principal',
  teacher: 'teacher',
  parent: 'parent',
  student: 'student',
};
export function schoolPath(path: string, role?: Role) {
  if (!role || path === '/platform' || path === '/login' || path.startsWith('/auth/')) return path;
  return `/${portals[role]}${path === '/' ? '' : path}`;
}
