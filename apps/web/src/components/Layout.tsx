import { useEffect, useState } from 'react';
import { NavLink, Outlet, Link, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  Users,
  GraduationCap,
  CalendarCheck2,
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
  HelpCircle,
  ShieldCheck,
  Building2,
  Layers3,
  ClipboardCheck,
} from 'lucide-react';
import { configured, useAuth } from '../lib/auth';
import { Button } from './ui/button';
import { cn } from '../lib/utils';
import { schoolPath } from '../lib/portals';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/auth';
import { display } from '../lib/utils';
const items = [
  { to: '/', text: 'Overview', icon: LayoutDashboard },
  { to: '/r/students', text: 'Students', icon: Users, permission: 'students.read' },
  { to: '/r/teachers', text: 'Teachers', icon: GraduationCap, permission: 'teachers.read' },
  { to: '/attendance', text: 'Attendance', icon: CalendarCheck2, permission: 'attendance.read' },
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
    navigate = useNavigate();
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
  const name =
      a.me?.school?.school_name ||
      (a.me?.platform_role === 'SUPER_ADMIN' ? 'Vidyalayaa platform' : 'Your school'),
    permissions = a.me?.school?.permissions || [],
    role = a.me?.school?.role,
    family = role === 'parent' || role === 'student',
    path = (value: string) => schoolPath(value, role);
  const platformOnly = configured && a.me?.platform_role === 'SUPER_ADMIN' && !role;
  const navigation: typeof items = platformOnly
    ? [
        { to: '/platform/health', text: 'Overview', icon: LayoutDashboard },
        { to: '/platform/schools', text: 'Schools', icon: Building2 },
        { to: '/platform/devices', text: 'Device inventory', icon: Radio },
        { to: '/platform/plans', text: 'Plans', icon: Layers3 },
        { to: '/platform/support-grants', text: 'Support access', icon: ShieldCheck },
      ]
    : items;
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
        <div className="school-selector">
          <span className="school-avatar">
            <Building2 size={20} />
          </span>
          <div>
            <strong>{name}</strong>
            {a.me?.memberships.length && a.me.memberships.length > 1 ? (
              <select
                aria-label="Active school"
                value={a.school}
                onChange={(e) => {
                  a.setSchool(e.target.value);
                  navigate('/');
                }}
              >
                {a.me.memberships.map((s) => (
                  <option value={s.school_id} key={s.school_id}>
                    {s.school_name}
                  </option>
                ))}
              </select>
            ) : (
              <span>
                {configured
                  ? a.me?.school?.role.replaceAll('_', ' ') ||
                    (platformOnly ? 'Super Admin' : 'Select a workspace')
                  : 'Workspace setup'}
              </span>
            )}
          </div>
          <ChevronDown size={14} />
        </div>
        <p className="nav-label">{platformOnly ? 'PLATFORM' : 'WORKSPACE'}</p>
        <nav aria-label="Main navigation">
          {navigation
            .filter((i) => !configured || !i.permission || permissions.includes(i.permission))
            .map((i) => (
              <NavLink
                key={i.to}
                to={path(i.to)}
                end={i.to === '/'}
                onClick={() => setOpen(false)}
                className={({ isActive }) => cn('nav-item', isActive && 'nav-active')}
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
          {permissions.includes('users.manage') && (
            <NavLink className="nav-item" to={path('/members')}>
              <Users size={18} />
              Members & invitations
            </NavLink>
          )}
        </nav>
        <div className="sidebar-bottom">
          <div className="support-card">
            <div className="support-circle">
              <HelpCircle size={19} />
            </div>
            <h3>A little help goes a long way.</h3>
            <p>We’re here for your school.</p>
            <a href="mailto:vidyalayaainfo@gmail.com">
              Let’s talk <ArrowUpRight size={14} />
            </a>
          </div>
          <NavLink to={path('/settings')} className="nav-item">
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
            <form
              className="global-search"
              onSubmit={(e) => {
                e.preventDefault();
                navigate(path('/r/students') + `?search=${encodeURIComponent(search)}`);
              }}
            >
              <Search size={16} />
              <input
                aria-label="Search students"
                placeholder="Find something…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <kbd>↵</kbd>
            </form>
            <Link
              to={
                permissions.includes('notifications.read') || !configured
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
              <button className="profile-button" onClick={() => a.logout()} aria-label="Sign out">
                <span>{a.me?.full_name.slice(0, 2).toUpperCase() || 'V'}</span>
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
          <Outlet />
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
        {family && (
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
      </div>
    </div>
  );
}
