import type { Role } from '@vidyalayaa/contracts';
export const portals: Record<Role, string> = {
  school_admin: 'admin',
  principal: 'principal',
  teacher: 'teacher',
  parent: 'parent',
  student: 'student',
  finance_staff: 'finance',
};
export function isSchoolLeadership(role?: Role) {
  return role === 'school_admin' || role === 'principal';
}

export function schoolPath(path: string, role?: Role) {
  if (
    !role ||
    path === '/platform' ||
    path.startsWith('/platform/') ||
    path === '/login' ||
    path.startsWith('/auth/')
  )
    return path;
  return `/${portals[role]}${path === '/' ? '' : path}`;
}

export const platformSections = [
  'schools',
  'devices',
  'plans',
  'support-grants',
  'health',
  'audit',
  'organizations',
  'usage',
  'offboarding',
  'support-requests',
  'notices',
  'firmware',
] as const;
