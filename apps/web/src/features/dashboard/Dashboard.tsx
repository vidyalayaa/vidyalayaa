import { lazy, Suspense } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  ArrowUpRight,
  ArrowRight,
  Users,
  CheckCheck,
  Clock3,
  UserX,
  Radio,
  Wifi,
  CalendarDays,
  Sparkles,
  Check,
  NotebookPen,
  Plus,
  GraduationCap,
} from 'lucide-react';
import { api, configured, useAuth } from '../../lib/auth';
import { Button } from '../../components/ui/button';
import { Badge, Empty, ErrorState, PageHeading, Panel, Loading } from '../../components/common';
import { AcademicOverview } from '../operations/SchoolTools';
import ParentPortalSection from './ParentPortalSection';
import TeacherPortalSection from './TeacherPortalSection';
import StudentPortalSection from './StudentPortalSection';
import AdminActionStrip from './AdminActionStrip';
import UpcomingEvents from '../calendar/UpcomingEvents';
import { schoolPath } from '../../lib/portals';
import Fees from '../fees/Fees';
import FeeOverview from '../fees/FeeOverview';
const Chart = lazy(() => import('./TrendChart'));
interface DashboardData {
  date: string;
  stats: { students: number; present: number; late: number; absent: number };
  trend: { date: string; present: number; total: number }[];
  recent: {
    id: string;
    first_name: string;
    last_name: string;
    student_code: string;
    attendance_status: string;
    movement_status: string;
    first_arrival_at: string | null;
    needs_review: boolean;
  }[];
  notices: { id: string; title: string; body: string; audience: string; published_at: string }[];
  deviceHealth: { total: number; online: number; pending: number } | null;
}
export default function Dashboard() {
  const a = useAuth(),
    role = a.me?.school?.role,
    query = useQuery({
      queryKey: [a.school, 'dashboard'],
      queryFn: () => api<DashboardData>('/dashboard'),
      enabled: configured && !!a.me?.school && role !== 'finance_staff',
      refetchInterval: 30000,
    });
  const d = query.data,
    name = a.me?.full_name.split(' ')[0];
  const stats = [
    {
      title: role === 'parent' ? 'Linked students' : 'Total students',
      value: d?.stats.students,
      icon: Users,
      detail: 'Active learners',
      color: 'lime',
    },
    {
      title: 'Present today',
      value: d?.stats.present,
      icon: CheckCheck,
      detail: 'Present, late & half day',
      color: 'green',
    },
    {
      title: 'Late arrivals',
      value: d?.stats.late,
      icon: Clock3,
      detail: 'After the on-time window',
      color: 'amber',
    },
    {
      title: 'Absent today',
      value: d?.stats.absent,
      icon: UserX,
      detail: 'Finalized attendance',
      color: 'rose',
    },
  ];
  if (role === 'finance_staff') return <Fees />;
  return (
    <>
      <PageHeading
        eyebrow={
          role === 'parent'
            ? 'A LITTLE CLOSER TO THEIR SCHOOL DAY'
            : role === 'teacher'
              ? 'MORE TIME FOR WHAT YOU DO BEST'
              : 'YOUR SCHOOL, IN SYNC'
        }
        title={name ? `Welcome back, ${name} 👋` : 'A clearer view of your school.'}
        description={
          role === 'parent'
            ? 'Their day, their progress, your peace of mind.'
            : 'A little less admin. A little more possibility.'
        }
        actions={
          <Button variant="outline" asChild>
            <Link to={schoolPath('/calendar', role)}>
              <CalendarDays size={16} />
              {new Intl.DateTimeFormat('en-IN', {
                day: 'numeric',
                month: 'short',
                year: 'numeric',
                timeZone: a.me?.school?.timezone || 'Asia/Kolkata',
              }).format(new Date())}
            </Link>
          </Button>
        }
      />
      {configured && a.me?.school?.permissions.includes('marks.read') && <AcademicOverview />}
      {!configured && (
        <div className="setup-banner">
          <span className="status-dot" />
          <span>
            Workspace preview · setup required. Connect your services to start using real school
            data.
          </span>
          <Link to="/settings">
            View setup <ArrowUpRight size={14} />
          </Link>
        </div>
      )}
      {query.error && <ErrorState error={query.error} retry={() => query.refetch()} />}
      {d?.deviceHealth && d.deviceHealth.online < d.deviceHealth.total && (
        <div className="notice">
          Attendance data may be delayed. One or more school devices is offline.
        </div>
      )}
      {configured && role === 'parent' && <ParentPortalSection />}
      {configured && role === 'teacher' && <TeacherPortalSection />}
      {configured && role === 'student' && <StudentPortalSection />}
      {configured && a.me?.school?.permissions.includes('calendar.read') && <UpcomingEvents />}
      {configured && (role === 'school_admin' || role === 'principal') && (
        <>
          <AdminActionStrip />
          <FeeOverview />
        </>
      )}
      <div className="hero-grid">
        <section className="welcome-card">
          <div className="hero-copy">
            <span className="tiny-pill">
              <Sparkles size={13} />A BETTER SCHOOL DAY STARTS HERE
            </span>
            <h2>
              A connected school.
              <br />A calmer day.
            </h2>
            <p>
              From the first tap at the gate to the last lesson.
              <br className="hidden md:block" /> Everything that matters, together.
            </p>
            <Button asChild>
              <Link to={configured ? '/attendance' : '/settings'}>
                {configured ? 'View attendance' : 'Set up your school'}
                <ArrowRight size={16} />
              </Link>
            </Button>
          </div>
          <div className="school-art" aria-hidden="true">
            <div className="art-orbit orbit-one" />
            <div className="art-orbit orbit-two" />
            <div className="art-building">
              <div className="art-roof" />
              <div className="art-clock">
                <Clock3 size={24} />
              </div>
              <div className="art-windows">
                {Array.from({ length: 6 }, (_, i) => (
                  <i key={i} />
                ))}
              </div>
              <div className="art-door" />
            </div>
            <div className="floating-tag tag-one">
              <Check size={14} />
              All together.
            </div>
            <div className="floating-tag tag-two">
              <GraduationCap size={18} />
            </div>
            <div className="art-ground" />
          </div>
        </section>
        <section className="connection-card">
          <div className="flex items-center justify-between">
            <span className="tiny-pill dark-pill">
              <Radio size={13} />
              CONNECTED CAMPUS
            </span>
            <ArrowUpRight size={20} />
          </div>
          <div className="connection-graphic" aria-hidden="true">
            <div />
            <div />
            <div />
            <span>
              <Wifi size={28} strokeWidth={1.5} />
            </span>
            <i className="node node-one" />
            <i className="node node-two" />
            <i className="node node-three" />
          </div>
          <h2>
            Every tap.
            <br />A little peace of mind.
          </h2>
          <div className="connection-footer">
            <p>
              {d?.deviceHealth
                ? `${d.deviceHealth.online} of ${d.deviceHealth.total} devices online`
                : 'Built for your school’s real rhythm'}
            </p>
            <Link
              to={
                a.me?.school?.permissions.includes('devices.read') || !configured
                  ? '/devices'
                  : role === 'parent'
                    ? '/notifications'
                    : '/attendance'
              }
              aria-label="View school updates"
            >
              <ArrowRight size={18} />
            </Link>
          </div>
        </section>
      </div>
      <div className="stats-grid">
        {stats.map((s) => (
          <div className="stat-card" key={s.title}>
            <div className="stat-top">
              <p>{s.title}</p>
              <span className={`stat-icon stat-${s.color}`}>
                <s.icon size={18} />
              </span>
            </div>
            <div className="stat-value">
              {query.isLoading ? '…' : (s.value ?? '—')}
              <span>{s.value === undefined ? 'Awaiting school data' : s.detail}</span>
            </div>
          </div>
        ))}
      </div>
      <div className="analytics-grid">
        <Panel
          title="Attendance overview"
          subtitle="A school week, at a glance."
          action={
            <Link className="text-link" to="/attendance">
              View report <ArrowUpRight size={15} />
            </Link>
          }
        >
          <div className="chart-legend">
            <span>
              <i />
              Present
            </span>
            <span>
              <i />
              Enrolled records
            </span>
            <span className="ml-auto text-stone-400">Last 7 days</span>
          </div>
          {query.isLoading ? (
            <Loading />
          ) : d?.trend.length ? (
            <Suspense fallback={<Loading />}>
              <Chart data={d.trend} />
            </Suspense>
          ) : (
            <div className="empty-chart">
              <div className="chart-lines">
                {[0, 1, 2, 3].map((x) => (
                  <span key={x} />
                ))}
              </div>
              <div>
                <div className="empty-icon">
                  <CheckCheck size={23} />
                </div>
                <h3>A picture of every school day</h3>
                <p>Your attendance trends will appear as records arrive.</p>
              </div>
              <div className="chart-days">
                {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((x) => (
                  <span key={x}>{x}</span>
                ))}
              </div>
            </div>
          )}
        </Panel>
        <Panel
          title="School noticeboard"
          subtitle="The latest from your community."
          action={
            <Link className="row-action" aria-label="View all announcements" to="/r/announcements">
              <ArrowUpRight size={17} />
            </Link>
          }
        >
          {d?.notices.length ? (
            <div className="notice-list">
              {d.notices.map((n, i) => (
                <Link to="/r/announcements" className="notice-item" key={n.id}>
                  <span className={`notice-icon notice-${i % 3}`}>
                    <NotebookPen size={18} />
                  </span>
                  <div>
                    <p className="text-xs text-stone-400">
                      {new Date(n.published_at).toLocaleDateString('en-IN', {
                        day: 'numeric',
                        month: 'short',
                      })}{' '}
                      · {n.audience.toLowerCase()}
                    </p>
                    <h3>{n.title}</h3>
                    <p className="line-clamp-2">{n.body}</p>
                  </div>
                </Link>
              ))}
            </div>
          ) : (
            <Empty
              title="Good things are on the way"
              description="School announcements will appear here."
            />
          )}
          <div className="panel-footer">
            <Link className="text-link" to="/r/announcements">
              Visit noticeboard <ArrowRight size={14} />
            </Link>
          </div>
        </Panel>
      </div>
      <Panel
        title={role === 'parent' ? 'Your children’s attendance' : 'Today’s attendance'}
        subtitle="The latest records, straight from your school."
        action={
          <Link className="text-link" to="/attendance">
            View all <ArrowUpRight size={15} />
          </Link>
        }
      >
        {d?.recent.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Student</th>
                  <th>Student ID</th>
                  <th>First arrival</th>
                  <th>Attendance</th>
                  <th>Movement</th>
                  <th>Review</th>
                </tr>
              </thead>
              <tbody>
                {d.recent.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <span className="person-cell">
                        <i>
                          {s.first_name[0]}
                          {s.last_name?.[0]}
                        </i>
                        {s.first_name} {s.last_name}
                      </span>
                    </td>
                    <td>{s.student_code}</td>
                    <td>
                      {s.first_arrival_at
                        ? new Date(s.first_arrival_at).toLocaleTimeString('en-IN', {
                            hour: 'numeric',
                            minute: '2-digit',
                            timeZone: a.me?.school?.timezone,
                          })
                        : '—'}
                    </td>
                    <td>
                      <Badge>{s.attendance_status}</Badge>
                    </td>
                    <td>
                      <Badge>{s.movement_status}</Badge>
                    </td>
                    <td>{s.needs_review ? 'Needs review' : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            title="Ready for the first school day"
            description="Attendance records appear here after your school starts recording them."
          />
        )}
      </Panel>
      <div className="dashboard-bottom">
        <span>
          <span className="brand-mini">v.</span>Made for the people who make a school.
        </span>
        <span>Vidyalayaa · Connected by care.</span>
      </div>
    </>
  );
}
