import { useState } from 'react';
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
const items = [
  { to: '/', text: 'Overview', icon: LayoutDashboard },
  { to: '/r/students', text: 'Students', icon: Users, permission: 'students.read' },
  { to: '/r/teachers', text: 'Teachers', icon: GraduationCap, permission: 'teachers.read' },
  { to: '/attendance', text: 'Attendance', icon: CalendarCheck2, permission: 'attendance.read' },
  { to: '/r/classes', text: 'Academics', icon: BookOpen, permission: 'academics.read' },
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
    navigate = useNavigate();
  const name = a.me?.school?.school_name || 'Your school',
    permissions = a.me?.school?.permissions || [];
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
        <Link to="/" className="brand">
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
                onChange={(e) => a.setSchool(e.target.value)}
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
                  ? a.me?.school?.role.replaceAll('_', ' ') || 'Select a workspace'
                  : 'Workspace setup'}
              </span>
            )}
          </div>
          <ChevronDown size={14} />
        </div>
        <p className="nav-label">WORKSPACE</p>
        <nav aria-label="Main navigation">
          {items
            .filter((i) => !configured || !i.permission || permissions.includes(i.permission))
            .map((i) => (
              <NavLink
                key={i.to}
                to={i.to}
                end={i.to === '/'}
                onClick={() => setOpen(false)}
                className={({ isActive }) => cn('nav-item', isActive && 'nav-active')}
              >
                <i.icon size={18} strokeWidth={1.7} />
                <span>{i.text}</span>
                {i.to === '/' && <span className="nav-active-dot" />}
              </NavLink>
            ))}
          {a.me?.platform_role === 'SUPER_ADMIN' && (
            <NavLink className="nav-item" to="/platform">
              <Layers3 size={18} />
              Platform console
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
          <NavLink to="/settings" className="nav-item">
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
                navigate(`/r/students?search=${encodeURIComponent(search)}`);
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
                  ? '/notifications'
                  : '/r/announcements'
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
        <main id="main-content" className="main-content" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
