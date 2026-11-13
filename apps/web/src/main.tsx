import { captureRenderFailure } from './lib/monitoring';
import React, { Suspense, lazy } from 'react';
import ReactDOM from 'react-dom/client';
import {
  createBrowserRouter,
  createRoutesFromElements,
  RouterProvider,
  Route,
  Navigate,
  useParams,
  useLocation,
  Outlet,
} from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { resourceNames, type Resource } from '@vidyalayaa/contracts';
import { AuthProvider, configured, useAuth, HttpError } from './lib/auth';
import { ThemeProvider } from './lib/theme';
import Layout from './components/Layout';
import { Loading, ErrorState, Empty } from './components/common';
import AuthenticatorSetup from './features/auth/AuthenticatorSetup';
import { resourceInfo } from './features/resources/metadata';
import { TeacherRoster, TeacherAssessments } from './features/operations/Teaching';

import './styles.css';
import { isSchoolLeadership, portals, schoolPath, platformSections } from './lib/portals';
const SchoolExports = lazy(() => import('./features/operations/SchoolExports'));
const SchoolProfile = lazy(() => import('./features/school-profile/SchoolProfile'));
const PlatformNotifications = lazy(() => import('./features/operations/PlatformNotifications'));
const Academics = lazy(() => import('./features/academics/Academics'));
const StudentDirectory = lazy(() => import('./features/students/StudentDirectory'));
const StudentProfile = lazy(() => import('./features/students/StudentProfile'));
const StaffProfile = lazy(() => import('./features/profiles/StaffProfile'));
const TeacherMaterials = lazy(() => import('./features/materials/TeacherMaterials'));
const StudentAcademics = lazy(() =>
  import('./features/students/StudentLearning').then((m) => ({ default: m.StudentAcademics })),
);
const StudentResults = lazy(() =>
  import('./features/students/StudentLearning').then((m) => ({ default: m.StudentResults })),
);
const SchoolCalendar = lazy(() => import('./features/calendar/SchoolCalendar'));
const SchoolResults = lazy(() => import('./features/results/SchoolResults'));
const AcademicStudentResults = lazy(() =>
  import('./features/results/AcademicStudentView').then((module) => ({
    default: module.AcademicStudentResults,
  })),
);
const AcademicDashboard = lazy(() => import('./features/results/AcademicDashboard'));
const HomeworkDiary = lazy(() => import('./features/homework/HomeworkDiary'));
const AcademicYears = lazy(() => import('./features/academics/AcademicYears'));
const Timetable = lazy(() => import('./features/timetable/Timetable'));
const Fees = lazy(() => import('./features/fees/Fees'));
const LoginSessions = lazy(() => import('./features/auth/LoginSessions'));
const AccountSettings = lazy(() => import('./features/auth/AccountSettings'));
const VerifyEmail = lazy(() => import('./features/auth/VerifyEmail'));
const Explore = lazy(() => import('./features/explore/Explore'));
const SchoolWelcome = lazy(() => import('./features/explore/SchoolWelcome'));
const AttendanceHistory = lazy(() =>
  import('./features/operations/SchoolTools').then((m) => ({ default: m.AttendanceHistory })),
);
const ResourceScreen = lazy(() =>
  import('./features/resources/ResourceScreen').then((m) => ({ default: m.ResourceScreen })),
);
const Attendance = lazy(() =>
  import('./features/operations/Screens').then((m) => ({ default: m.Attendance })),
);
const Devices = lazy(() =>
  import('./features/operations/Screens').then((m) => ({ default: m.Devices })),
);
const Corrections = lazy(() =>
  import('./features/operations/Screens').then((m) => ({ default: m.Corrections })),
);
const Reports = lazy(() =>
  import('./features/operations/Screens').then((m) => ({ default: m.Reports })),
);
const Notifications = lazy(() => import('./features/notifications/Notifications'));
const Members = lazy(() =>
  import('./features/operations/Screens').then((m) => ({ default: m.Members })),
);
const Audit = lazy(() =>
  import('./features/operations/Screens').then((m) => ({ default: m.Audit })),
);
const SupportGrants = lazy(() =>
  import('./features/operations/Screens').then((m) => ({ default: m.SupportGrants })),
);
const AuthCallback = lazy(() =>
  import('./features/auth/Login').then((m) => ({ default: m.AuthCallback })),
);
const GoogleCallback = lazy(() =>
  import('./features/auth/Login').then((m) => ({ default: m.GoogleCallback })),
);
const Dashboard = lazy(() => import('./features/dashboard/Dashboard')),
  Login = lazy(() => import('./features/auth/Login')),
  Settings = lazy(() => import('./features/operations/Settings')),
  Platform = lazy(() => import('./features/operations/Platform'));
const client = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30000,
      retry: (count, error) => count < 2 && (!(error instanceof HttpError) || error.status >= 500),
      retryDelay: (count) => Math.min(1000 * 2 ** count, 10000),
      refetchOnWindowFocus: true,
    },
  },
});
function Guard() {
  const a = useAuth(),
    location = useLocation();
  if (a.loading) return <Loading />;
  if (configured && !a.session)
    return <Navigate to={`/login?returnTo=${encodeURIComponent(location.pathname)}`} replace />;
  if (a.error instanceof HttpError && a.error.code === 'MFA_REQUIRED')
    return (
      <Navigate
        to={`/login?mfa=1&returnTo=${encodeURIComponent(location.pathname + location.search)}`}
        replace
      />
    );
  if (
    a.error instanceof HttpError &&
    a.error.code === 'SCHOOL_CONTEXT_UNAVAILABLE' &&
    a.requestSchool
  )
    return location.pathname === '/' ? <Loading /> : <Navigate to="/" replace />;
  if (a.error instanceof HttpError && a.error.code === 'SCHOOL_LOGIN_DISABLED')
    return (
      <div className="mx-auto mt-16 max-w-xl rounded-2xl border bg-surface p-8">
        <h1 className="text-xl font-semibold">School sign-in paused</h1>
        <p className="my-4">{a.error.message}</p>
        <div className="flex flex-wrap gap-4">
          {a.requestSchool && (
            <button className="underline" onClick={() => a.setSchool('')}>
              Choose another workspace
            </button>
          )}
          <button className="underline" onClick={() => void a.logout()}>
            Sign out
          </button>
        </div>
      </div>
    );
  if (a.error) return <ErrorState error={a.error} retry={a.refetch} />;
  if (a.me?.security_mfa_required)
    return (
      <div className="mx-auto mt-16 max-w-xl rounded-2xl border bg-surface p-8">
        <h1 className="text-xl font-semibold">Secure your account</h1>
        <p className="my-4">
          Your role requires an authenticator. Enroll and verify it to continue.
        </p>
        <AuthenticatorSetup />
        <button
          className="mt-4 underline"
          onClick={() => {
            if (window.confirm('Are you sure you want to sign out?')) a.logout();
          }}
        >
          Sign out
        </button>
      </div>
    );
  if (configured && a.me) {
    if (location.pathname.startsWith('/platform') && a.me.platform_role !== 'SUPER_ADMIN')
      return (
        <div className="flex min-h-[70vh] flex-col items-center justify-center p-6">
          <Empty
            title="Access unavailable"
            description="The platform console requires a Super Admin account."
            showHome
          />
        </div>
      );
    if (location.pathname === '/' && a.me.platform_role === 'SUPER_ADMIN')
      return <Navigate to="/platform" replace />;
    const prefix = location.pathname.split('/')[1];
    if (
      a.me.school &&
      !Object.values(portals).includes(prefix) &&
      !location.pathname.startsWith('/platform')
    )
      return (
        <Navigate to={schoolPath(location.pathname, a.me.school.role) + location.search} replace />
      );
  }
  if (a.me && !a.me.school) {
    if (a.me.platform_role === 'SUPER_ADMIN') {
      if (!location.pathname.startsWith('/platform') && !location.pathname.startsWith('/settings'))
        return <Navigate to="/platform" replace />;
    } else if (!['/settings/security', '/settings/account'].includes(location.pathname))
      return <SchoolWelcome />;
  }
  return <Layout key={`${a.me?.id}:${a.school}:${a.me?.school?.role}`} />;
}
function PortalGate() {
  const a = useAuth(),
    { portal } = useParams();
  if (
    !Object.values(portals).includes(portal || '') ||
    (configured && (!a.me?.school || portals[a.me.school.role] !== portal))
  )
    return (
      <div className="flex min-h-[70vh] flex-col items-center justify-center p-6">
        <Empty
          title="Access unavailable"
          description="Choose a school and use your assigned role's workspace."
          showHome
        />
      </div>
    );
  return <Outlet />;
}
function ResourcePage() {
  const { resource } = useParams();
  const a = useAuth();
  const location = useLocation();
  if (!resourceNames.includes(resource as Resource)) return <Empty title="Page not found" />;
  const name = resource as Resource;
  const role = a.me?.school?.role;
  if (
    a.me?.school?.role === 'student' &&
    ['teacher_class_assignments', 'enrollments', 'fee_records'].includes(name)
  )
    return (
      <Empty
        title="Access unavailable"
        description="This section is unavailable in the student workspace."
      />
    );
  if (name === 'school_holidays')
    return <Navigate replace to={schoolPath('/calendar', a.me?.school?.role) + location.search} />;
  if (a.me?.school?.role === 'teacher') {
    if (['students', 'parents', 'student_parents'].includes(name)) return <TeacherRoster />;
    if (['marks', 'exams'].includes(name)) return <TeacherAssessments kind="SUBJECT_TEST" />;
    if (['classes', 'academic_sessions', 'teacher_class_assignments'].includes(name))
      return (
        <Empty
          title="Access unavailable"
          description="Academic Administration belongs to School Admin. Use your teaching workspace."
        />
      );
  }
  if (configured && !a.me?.school?.permissions.includes(resourceInfo[name].permission))
    return (
      <Empty
        title="This area belongs to another role"
        description="Your school administrator can help with access."
      />
    );
  if (a.me?.school?.role === 'student') {
    if (['classes', 'academic_sessions', 'subjects'].includes(name))
      return <StudentAcademics key={a.school} />;
    if (name === 'marks') return <AcademicStudentResults key={a.school} />;
    if (name === 'exams') return <StudentResults key={a.school} />;
  }
  if (isSchoolLeadership(role) && name === 'marks') return <SchoolResults key={a.school} />;
  if (name === 'timetable_entries') return <Timetable key={a.school} />;
  if (name === 'assignments') return <HomeworkDiary key={a.school} />;
  if (name === 'fee_records') return <Fees key={a.school} />;
  if (isSchoolLeadership(role) && ['students', 'parents', 'student_parents'].includes(name)) {
    const params = new URLSearchParams(location.search);
    if (name !== 'students' || params.has('view')) {
      params.delete('view');
      return (
        <Navigate
          replace
          to={schoolPath('/r/students', role) + (params.size ? '?' + params.toString() : '')}
        />
      );
    }
    return <StudentDirectory key={a.school} />;
  }
  if (
    isSchoolLeadership(role) &&
    (name === 'classes' ||
      (role === 'school_admin' &&
        ['academic_sessions', 'subjects', 'teacher_class_assignments'].includes(name)))
  )
    return <Navigate replace to={schoolPath('/academics', role)} />;
  if (a.me?.school?.role === 'school_admin' && name === 'enrollments')
    return <Navigate replace to={schoolPath('/r/students', 'school_admin')} />;
  if (a.me?.school?.role === 'student' && name === 'students')
    return <Navigate replace to="/student/profile" />;
  return <ResourceScreen key={name} resource={name} />;
}
function Permission({ code, children }: { code: string; children: React.ReactNode }) {
  const a = useAuth();
  return !configured || a.me?.school?.permissions.includes(code) ? (
    children
  ) : (
    <Empty title="Access unavailable" description="Your current role cannot view this area." />
  );
}
function AcademicPage() {
  const a = useAuth();
  return a.me?.school?.role === 'student' ? (
    <StudentAcademics key={a.school} />
  ) : (
    <Permission code="academics.read">
      <Academics />
    </Permission>
  );
}
class Boundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    captureRenderFailure(error);
  }
  render() {
    return this.state.error ? <ErrorState error={this.state.error} /> : this.props.children;
  }
}
function schoolRoutes() {
  return (
    <>
      <Route index element={<Dashboard />} />
      <Route path="profile" element={<OwnSchoolProfile />} />
      <Route
        path="academic-intelligence"
        element={
          <Permission code="marks.read">
            <AcademicDashboard />
          </Permission>
        }
      />
      <Route
        path="materials"
        element={
          <Permission code="assignments.read">
            <TeacherMaterials />
          </Permission>
        }
      />
      <Route
        path="calendar"
        element={
          <Permission code="calendar.read">
            <SchoolCalendar />
          </Permission>
        }
      />
      <Route path="academics" element={<AcademicPage />} />
      <Route
        path="academic-years"
        element={
          <Permission code="academics.read">
            <AcademicYears />
          </Permission>
        }
      />
      <Route
        path="classroom"
        element={
          <Permission code="classrooms.read">
            <TeacherRoster />
          </Permission>
        }
      />
      <Route
        path="subject-tests"
        element={
          <Permission code="classrooms.read">
            <TeacherAssessments kind="SUBJECT_TEST" />
          </Permission>
        }
      />
      <Route
        path="official-results"
        element={
          <Permission code="classrooms.read">
            <TeacherAssessments kind="OFFICIAL" />
          </Permission>
        }
      />
      <Route
        path="exports"
        element={
          <Permission code="school.manage">
            <SchoolExports />
          </Permission>
        }
      />
      <Route path="r/:resource" element={<ResourcePage />} />
      <Route
        path="attendance/history"
        element={
          <Permission code="attendance.read">
            <AttendanceHistory />
          </Permission>
        }
      />
      <Route
        path="attendance"
        element={
          <Permission code="attendance.read">
            <Attendance />
          </Permission>
        }
      />
      <Route
        path="devices"
        element={
          <Permission code="devices.read">
            <Devices />
          </Permission>
        }
      />
      <Route
        path="corrections"
        element={
          <Permission code="attendance.read">
            <Corrections />
          </Permission>
        }
      />
      <Route
        path="reports"
        element={
          <Permission code="reports.export">
            <Reports />
          </Permission>
        }
      />
      <Route
        path="notifications"
        element={
          <Permission code="notifications.read">
            <Notifications />
          </Permission>
        }
      />
      <Route
        path="members"
        element={
          <Permission code="users.manage">
            <Members />
          </Permission>
        }
      />
      <Route
        path="audit"
        element={
          <Permission code="audit.read">
            <Audit />
          </Permission>
        }
      />
      <Route
        path="support"
        element={
          <Permission code="users.manage">
            <SupportGrants />
          </Permission>
        }
      />
      <Route path="settings" element={<Settings />} />
      <Route path="school-information" element={<SchoolProfile />} />
      <Route path="settings/security" element={<LoginSessions />} />
      <Route path="settings/account" element={<AccountSettings />} />
    </>
  );
}
function OwnSchoolProfile() {
  const role = useAuth().me?.school?.role;
  return role === 'student' ? <StudentProfile /> : <StaffProfile />;
}
const router = createBrowserRouter(
  createRoutesFromElements(
    <>
      <Route path="/explore" element={<Explore />} />
      <Route path="/login" element={<Login />} />
      <Route path="/auth/callback" element={<AuthCallback />} />
      <Route path="/auth/verify" element={<VerifyEmail />} />
      <Route path="/auth/google/callback" element={<GoogleCallback />} />
      <Route element={<Guard />}>
        {schoolRoutes()}
        <Route path=":portal" element={<PortalGate />}>
          {schoolRoutes()}
        </Route>
        <Route path="platform/schools/:schoolId/profile" element={<SchoolProfile />} />
        <Route path="platform/notifications" element={<PlatformNotifications />} />
        {platformSections.map((section) => (
          <Route key={section} path={`platform/${section}`} element={<Platform />} />
        ))}
        <Route path="platform/*" element={<Platform />} />
        <Route
          path="*"
          element={
            <div className="flex min-h-[70vh] flex-col items-center justify-center p-6">
              <Empty
                title="This page has moved"
                description="Use the workspace navigation to find your way."
                showHome
              />
            </div>
          }
        />
      </Route>
    </>,
  ),
);
window.addEventListener('vidyalayaa:step-up', (event) => {
  const enroll = (event as CustomEvent).detail?.enroll;
  router.navigate(
    enroll
      ? '/settings'
      : `/login?mfa=1&recent=1&returnTo=${encodeURIComponent(location.pathname + location.search)}`,
  );
});
import SplashScreen from './components/SplashScreen';

function App() {
  const [showSplash, setShowSplash] = React.useState(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
    if (sessionStorage.getItem('vidyalayaa_splash_shown')) return false;
    sessionStorage.setItem('vidyalayaa_splash_shown', '1');
    return true;
  });
  const hideSplash = React.useCallback(() => setShowSplash(false), []);
  return (
    <React.StrictMode>
      <Boundary>
        <QueryClientProvider client={client}>
          <AuthProvider>
            <ThemeProvider>
              {showSplash && <SplashScreen onFinished={hideSplash} />}
              <Suspense fallback={<Loading />}>
                <RouterProvider router={router} />
              </Suspense>
            </ThemeProvider>
          </AuthProvider>
        </QueryClientProvider>
      </Boundary>
    </React.StrictMode>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(<App />);
