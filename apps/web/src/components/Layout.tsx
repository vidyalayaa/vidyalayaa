import PushUpdates from '../features/notifications/PushUpdates';
import { ThemeSelect } from './ThemeSelect';
import { OwnProfileAvatar } from '../features/profiles/PersonAvatar';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, Link, useNavigate, useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  Users,
  UserRound,
  GraduationCap,
  CalendarCheck2,
  CalendarDays,
  BookOpen,
  Wallet,
  Radio,
  FileChartColumn,
  Megaphone,
  Settings2,
  ChevronDown,
  Search,
  Bell,
  Menu,
  X,
  LogOut,
  ArrowUpRight,
  ShieldCheck,
  Building2,
  Layers3,
  ClipboardCheck,
  HeartHandshake,
  Compass,
} from 'lucide-react';
import { configured, useAuth } from '../lib/auth';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';
import SupportContact from './SupportContact';
import { cn } from '../lib/utils';
import { Loading } from './common';
import { isSchoolLeadership, schoolPath } from '../lib/portals';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/auth';
import { display } from '../lib/utils';
import { SchoolDeletionApproval } from '../features/operations/SchoolDeletion';
const ParentWorkspace = lazy(() => import('../features/parents/ParentWorkspace'));
const navigationFeatures: Record<string, string> = {
  '/r/assignments': 'assignments',
  '/r/timetable_entries': 'timetable',
  '/devices': 'nfc_attendance',
};
const items = [
  { to: '/', text: 'Overview', icon: LayoutDashboard },
  { to: '/r/students', text: 'Students', icon: Users, permission: 'students.read' },
  { to: '/r/parents', text: 'Parents', icon: Users, permission: 'parents.read' },
  {
    to: '/r/student_parents',
    text: 'Family links',
    icon: HeartHandshake,
    permission: 'parents.read',
  },
  { to: '/r/teachers', text: 'School staff', icon: GraduationCap, permission: 'teachers.read' },
  {
    to: '/r/teacher_class_assignments',
    text: 'Teacher assignments',
    icon: GraduationCap,
    permission: 'teachers.write',
  },
  { to: '/attendance', text: 'Attendance', icon: CalendarCheck2, permission: 'attendance.read' },
  { to: '/calendar', text: 'Calendar', icon: CalendarDays, permission: 'calendar.read' },
  { to: '/r/classes', text: 'Academics', icon: BookOpen, permission: 'academics.read' },
  { to: '/r/assignments', text: 'Homework', icon: BookOpen, permission: 'assignments.read' },
  { to: '/r/marks', text: 'Results', icon: GraduationCap, permission: 'marks.read' },
  {
    to: '/r/timetable_entries',
    text: 'Timetable',
    icon: CalendarCheck2,
    permission: 'timetable.read',
  },
  { to: '/r/fee_records', text: 'Fees', icon: Wallet, permission: 'fees.read' },
  { to: '/devices', text: 'NFC devices', icon: Radio, permission: 'devices.read' },
  { to: '/reports', text: 'Reports', icon: FileChartColumn, permission: 'reports.export' },
  {
    to: '/r/announcements',
    text: 'Announcements',
    icon: Megaphone,
    permission: 'announcements.read',
  },
  { to: '/notifications', text: 'Notifications', icon: Bell, permission: 'notifications.read' },
  { to: '/corrections', text: 'Corrections', icon: ClipboardCheck, permission: 'attendance.read' },
];
export default function Layout() {
  const a = useAuth(),
    [open, setOpen] = useState(false),
    [search, setSearch] = useState(''),
    [online, setOnline] = useState(navigator.onLine),
    [confirmLogout, setConfirmLogout] = useState(false),
    [loggingOut, setLoggingOut] = useState(false),
    schoolMenu = useRef<HTMLDetailsElement>(null),
    navigate = useNavigate(),
    location = useLocation();

  const handleLogout = async () => {
    setLoggingOut(true);
    try {
      await a.logout();
    } finally {
      setLoggingOut(false);
      setConfirmLogout(false);
    }
  };
  const support = useQuery({
    queryKey: [a.school, 'support-access'],
    queryFn: () =>
      api<{ data: { ticket_ref: string; expires_at: string; scope: string[] }[] }>(
        '/support-access',
      ),
    enabled: configured && !!a.me?.school?.permissions.includes('users.manage'),
    refetchInterval: 30000,
  });
  useEffect(() => {
    const change = () => setOnline(navigator.onLine);
    window.addEventListener('online', change);
    window.addEventListener('offline', change);
    return () => {
      window.removeEventListener('online', change);
      window.removeEventListener('offline', change);
    };
  }, []);
  const permissions = a.me?.school?.permissions || [],
    role = a.me?.school?.role,
    family =
      !location.pathname.startsWith('/platform') && (role === 'parent' || role === 'student');
  const platformOnly =
    configured &&
    a.me?.platform_role === 'SUPER_ADMIN' &&
    (!role || location.pathname.startsWith('/platform'));
  const name = platformOnly ? 'Vidyalayaa platform' : a.me?.school?.school_name || 'Your school';
  const memberships = a.me?.memberships || [];
  const canSwitchSchool = memberships.length > 1;
  const canExportSchool = !platformOnly && (!configured || permissions.includes('school.manage'));
  const closeSchoolMenu = () => {
    if (schoolMenu.current) schoolMenu.current.open = false;
    setOpen(false);
  };
  const schoolLabel = (
    <>
      <span className="school-avatar" aria-hidden="true">
        <Building2 size={20} />
      </span>
      <span className="school-selector-label">
        <strong>{name}</strong>
        <span>
          {configured
            ? platformOnly
              ? 'Super Admin'
              : role?.replaceAll('_', ' ') || 'Select a workspace'
            : 'Workspace setup'}
        </span>
      </span>
    </>
  );
  const path = (value: string) =>
    platformOnly && value === '/' ? '/platform' : schoolPath(value, role);
  const navigation: typeof items = platformOnly
    ? [
        { to: '/platform/health', text: 'Overview', icon: LayoutDashboard },
        { to: '/platform/schools', text: 'Schools', icon: Building2 },
        { to: '/platform/devices', text: 'Device inventory', icon: Radio },
        { to: '/platform/firmware', text: 'Firmware updates', icon: Radio },
        { to: '/platform/plans', text: 'Plans', icon: Layers3 },
        { to: '/platform/support-grants', text: 'Support access', icon: ShieldCheck },
        { to: '/platform/support-requests', text: 'Support requests', icon: ShieldCheck },
        { to: '/platform/notices', text: 'Platform notices', icon: Bell },
        { to: '/platform/notifications', text: 'School notifications', icon: Bell },
        { to: '/platform/audit', text: 'Audit history', icon: ShieldCheck },
        { to: '/platform/organizations', text: 'Campus groups', icon: Building2 },
        { to: '/platform/usage', text: 'Usage', icon: Layers3 },
        { to: '/platform/offboarding', text: 'School closure', icon: ShieldCheck },
      ]
    : a.me?.school?.role === 'teacher'
      ? [
          ...items.filter(
            (i) =>
              ![
                '/r/students',
                '/r/parents',
                '/r/student_parents',
                '/r/teachers',
                '/r/classes',
                '/r/marks',
              ].includes(i.to),
          ),
          {
            to: '/classroom',
            text: 'Students & Parents',
            icon: Users,
            permission: 'classrooms.read',
          },
          {
            to: '/subject-tests',
            text: 'Subject tests',
            icon: BookOpen,
            permission: 'classrooms.read',
          },
          {
            to: '/materials',
            text: 'Study materials',
            icon: BookOpen,
            permission: 'assignments.read',
          },
          {
            to: '/official-results',
            text: 'Official exam results',
            icon: GraduationCap,
            permission: 'classrooms.read',
          },
        ]
      : isSchoolLeadership(role)
        ? items
            .filter(
              (i) =>
                !['/r/teacher_class_assignments', '/r/parents', '/r/student_parents'].includes(
                  i.to,
                ),
            )
            .map((i) => (i.to === '/r/classes' ? { ...i, to: '/academics' } : i))
        : role === 'student'
          ? items
              .filter(
                (i) =>
                  ![
                    '/r/parents',
                    '/r/student_parents',
                    '/r/teachers',
                    '/r/teacher_class_assignments',
                    '/r/fee_records',
                  ].includes(i.to),
              )
              .map((i) =>
                i.to === '/r/students' ? { ...i, to: '/profile', text: 'My profile' } : i,
              )
          : items;

  const isItemActive = (to: string, isActive: boolean) => {
    if (isActive) return true;
    const current = location.pathname;
    if (to === '/attendance') {
      return (
        current.includes('/attendance') ||
        current.includes('/r/nfc_cards') ||
        current.includes('/r/attendance_rule_versions') ||
        current.includes('/r/school_holidays')
      );
    }
    if (to === '/r/students') {
      return (
        current.includes('/r/students') ||
        current.includes('/r/parents') ||
        current.includes('/r/student_parents')
      );
    }
    if (to === '/academics' || to === '/r/classes') {
      return (
        current.includes('/academics') ||
        current.includes('/r/classes') ||
        current.includes('/r/academic_sessions') ||
        current.includes('/r/subjects') ||
        current.includes('/r/enrollments') ||
        current.includes('/r/teacher_class_assignments')
      );
    }
    if (to === '/devices') {
      return current.includes('/devices') || current.includes('/r/device_locations');
    }
    if (to === '/r/marks') return current.endsWith('/r/exams');
    return false;
  };

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      {open && (
        <button
          className="sidebar-overlay"
          onClick={() => setOpen(false)}
          aria-label="Close navigation"
        />
      )}
      <aside className={cn('sidebar', open && 'sidebar-open')}>
        <Link to={path('/')} className="brand">
          <span className="brand-symbol">
            v<span />
          </span>
          <span>
            vidyalayaa<span className="brand-period">.</span>
          </span>
        </Link>
        <button
          className="mobile-close"
          onClick={() => setOpen(false)}
          aria-label="Close navigation"
        >
          <X size={20} />
        </button>
        {!platformOnly || canSwitchSchool ? (
          <details
            ref={schoolMenu}
            className="school-switcher"
            onKeyDown={(event) => {
              if (event.key === 'Escape' && event.currentTarget.open) {
                event.stopPropagation();
                event.currentTarget.querySelector('summary')?.focus();
                event.currentTarget.open = false;
              }
            }}
          >
            <summary className="school-selector" aria-label={`School menu: ${name}`}>
              {schoolLabel}
              <ChevronDown className="school-selector-chevron" size={14} aria-hidden="true" />
            </summary>
            <nav className="school-actions" aria-label="School actions">
              {canSwitchSchool && (
                <label className="school-switch-control">
                  Active school
                  <select
                    value={a.school}
                    onChange={(e) => {
                      a.setSchool(e.target.value);
                      closeSchoolMenu();
                      navigate('/');
                    }}
                  >
                    {memberships.map((s) => (
                      <option value={s.school_id} key={s.school_id}>
                        {s.school_name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {!platformOnly && (
                <NavLink
                  to={path('/school-information')}
                  className="nav-item"
                  onClick={closeSchoolMenu}
                >
                  <Building2 size={17} aria-hidden="true" />
                  School information
                </NavLink>
              )}
              {canExportSchool && (
                <NavLink to={path('/exports')} className="nav-item" onClick={closeSchoolMenu}>
                  <Layers3 size={17} aria-hidden="true" />
                  School exports
                </NavLink>
              )}
            </nav>
          </details>
        ) : (
          <div className="school-switcher">
            <div className="school-selector">{schoolLabel}</div>
          </div>
        )}
        <p className="nav-label">{platformOnly ? 'PLATFORM' : 'WORKSPACE'}</p>
        <nav aria-label="Main navigation">
          {navigation
            .filter(
              (i) =>
                !configured ||
                ((!i.permission || permissions.includes(i.permission)) &&
                  (!navigationFeatures[i.to] || a.me?.features[navigationFeatures[i.to]])),
            )
            .map((i) => (
              <NavLink
                key={i.to}
                to={path(i.to)}
                end={i.to === '/'}
                onClick={closeSchoolMenu}
                className={({ isActive }) =>
                  cn('nav-item', isItemActive(i.to, isActive) && 'nav-active')
                }
              >
                <i.icon size={18} strokeWidth={1.7} />
                <span>{i.text}</span>
                {i.to === '/' && <span className="nav-active-dot" />}
              </NavLink>
            ))}
          {a.me?.platform_role === 'SUPER_ADMIN' && !platformOnly && (
            <NavLink className="nav-item" to="/platform">
              <Layers3 size={18} />
              Platform console
            </NavLink>
          )}
          {role && !platformOnly && role !== 'parent' && role !== 'student' && (
            <NavLink
              to={path('/profile')}
              onClick={closeSchoolMenu}
              className={({ isActive }) => cn('nav-item', isActive && 'nav-active')}
            >
              <UserRound size={18} /> My profile
            </NavLink>
          )}
          {permissions.includes('users.manage') && !platformOnly && (
            <NavLink className="nav-item" to={path('/members')}>
              <Users size={18} />
              Members & invitations
            </NavLink>
          )}
        </nav>
        <div className="sidebar-bottom">
          <Link to="/explore" className="nav-item" onClick={() => setOpen(false)}>
            <Compass size={18} />
            Explore Vidyalayaa
          </Link>
          <SupportContact
            requestPath={
              !platformOnly && permissions.includes('users.manage') ? path('/support') : undefined
            }
            onNavigate={closeSchoolMenu}
          />
          <NavLink to={path('/settings')} className="nav-item" onClick={() => setOpen(false)}>
            <Settings2 size={18} />
            Settings
          </NavLink>
          <p className="sidebar-foot">
            <ShieldCheck size={13} />
            Your school. Your data.
          </p>
        </div>
      </aside>
      <div className="main-column">
        <header className="topbar">
          <div className="flex items-center gap-3">
            <Button
              className="mobile-menu"
              size="icon"
              variant="ghost"
              aria-label="Open navigation"
              onClick={() => setOpen(true)}
            >
              <Menu size={21} />
            </Button>
            <span className="topbar-title">
              Workspace <span>/</span> <strong>{name}</strong>
            </span>
          </div>
          <div className="topbar-actions">
            {role !== 'parent' && (
              <form
                className="global-search"
                onSubmit={(e) => {
                  e.preventDefault();
                  navigate(
                    (platformOnly ? '/platform/schools' : path('/r/students')) +
                      `?search=${encodeURIComponent(search)}`,
                  );
                }}
              >
                <Search size={16} />
                <input
                  aria-label={platformOnly ? 'Search schools' : 'Search students'}
                  maxLength={120}
                  placeholder="Find something…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                <kbd>↵</kbd>
              </form>
            )}
            <ThemeSelect compact />
            <Link
              to={
                platformOnly
                  ? '/platform/notices'
                  : permissions.includes('notifications.read') || !configured
                    ? path('/notifications')
                    : path('/r/announcements')
              }
              className="notification-button"
              aria-label="Notifications"
            >
              <Bell size={19} />
            </Link>
            <div className="topbar-divider" />
            {a.session ? (
              <button
                className="profile-button"
                onClick={() => setConfirmLogout(true)}
                aria-label="Sign out"
              >
                <OwnProfileAvatar />
                <LogOut size={15} />
              </button>
            ) : (
              <Button variant="outline" size="sm" asChild>
                <Link to="/login">
                  Sign in <ArrowUpRight size={13} />
                </Link>
              </Button>
            )}
          </div>
        </header>
        <main
          id="main-content"
          className={cn('main-content', family && 'family-content')}
          tabIndex={-1}
        >
          {!online && (
            <div className="notice" role="status">
              You’re offline. Reconnect before saving changes. Loaded records may be out of date.
            </div>
          )}
          <PushUpdates />
          {!platformOnly && role === 'school_admin' && a.session && <SchoolDeletionApproval />}
          {role === 'parent' &&
          family &&
          !/\/(?:settings|school-information)(?:\/|$)/.test(location.pathname) ? (
            <Suspense fallback={<Loading />}>
              <ParentWorkspace />
            </Suspense>
          ) : (
            <Outlet />
          )}
          {!!support.data?.data.length && (
            <div className="notice mt-5" role="status">
              <ShieldCheck size={18} />
              <div>
                Approved support access is active.{' '}
                {support.data.data.map((g) => (
                  <p key={g.ticket_ref}>
                    {g.ticket_ref} · {g.scope.join(', ')} · expires{' '}
                    {display(g.expires_at, a.me?.school?.timezone)}
                  </p>
                ))}
                <Link to={path('/support')} className="underline">
                  Review or revoke access
                </Link>
              </div>
            </div>
          )}
        </main>
        {family && !open && (
          <nav className="family-navigation" aria-label="Family navigation">
            {[
              { to: '/', text: 'Home', Icon: LayoutDashboard },
              { to: '/attendance', text: 'Attendance', Icon: CalendarCheck2 },
              { to: '/r/assignments', text: 'Homework', Icon: BookOpen },
              { to: '/r/marks', text: 'Results', Icon: GraduationCap },
              { to: '/settings', text: 'Settings', Icon: Settings2 },
            ].map(({ to, text, Icon }) => (
              <NavLink
                key={to}
                to={path(to)}
                end={to === '/'}
                className={({ isActive }) => cn('family-nav-item', isActive && 'family-nav-active')}
              >
                <Icon size={20} />
                <span>{text}</span>
              </NavLink>
            ))}
          </nav>
        )}
        <Dialog
          open={confirmLogout}
          size="compact"
          onOpenChange={(v) => !loggingOut && setConfirmLogout(v)}
          title="Sign out of your account?"
          description="Are you sure you want to end your current session? You will need to sign in again to access Vidyalayaa."
        >
          <div className="space-y-4 pt-1">
            <div className="flex items-center gap-3 rounded-xl border border-stone-100 bg-stone-50 p-3">
              <div className="flex size-10 items-center justify-center rounded-full bg-lime-100 font-semibold text-lime-900">
                {a.me?.full_name.slice(0, 2).toUpperCase() || 'V'}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-stone-900">
                  {a.me?.full_name || 'Signed in user'}
                </p>
                <p className="truncate text-xs text-stone-500">{a.me?.email}</p>
              </div>
              {a.me?.school?.school_name && (
                <span className="rounded-lg border border-stone-200 bg-surface px-2 py-1 text-xs font-medium text-stone-600 shadow-sm">
                  {a.me.school.school_name}
                </span>
              )}
            </div>
            <div className="flex items-center justify-end gap-3 pt-2">
              <Button
                variant="outline"
                type="button"
                onClick={() => setConfirmLogout(false)}
                disabled={loggingOut}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                type="button"
                onClick={handleLogout}
                disabled={loggingOut}
              >
                <LogOut size={15} />
                {loggingOut ? 'Signing out…' : 'Sign out'}
              </Button>
            </div>
          </div>
        </Dialog>
      </div>
    </div>
  );
}
