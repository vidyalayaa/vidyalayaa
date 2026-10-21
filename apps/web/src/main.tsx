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
import Layout from './components/Layout';
import { Loading, ErrorState, Empty } from './components/common';
import AuthenticatorSetup from './features/auth/AuthenticatorSetup';
import PendingInvitations from './features/auth/PendingInvitations';
import { resourceInfo } from './features/resources/metadata';
import { TeacherRoster, TeacherAssessments } from './features/operations/Teaching';

import './styles.css';
import { portals, schoolPath, platformSections } from './lib/portals';
const SchoolExports = lazy(() => import('./features/operations/SchoolExports'));
const Academics = lazy(() => import('./features/academics/Academics'));
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
const Notifications = lazy(() =>
  import('./features/operations/Screens').then((m) => ({ default: m.Notifications })),
);
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
  if (a.error) return <ErrorState error={a.error} retry={a.refetch} />;
  if (a.me?.security_mfa_required)
    return (
      <div className="mx-auto mt-16 max-w-xl rounded-2xl border bg-white p-8">
        <h1 className="text-xl font-semibold">Secure your school account</h1>
        <p className="my-4">
          Your school requires an authenticator. Enroll and verify it to continue.
        </p>
        <AuthenticatorSetup />
        <button className="mt-4 underline" onClick={() => a.logout()}>
          Sign out
        </button>
      </div>
    );
  if (configured && a.me) {
    if (location.pathname.startsWith('/platform') && a.me.platform_role !== 'SUPER_ADMIN')
      return (
        <Empty
          title="Access unavailable"
          description="The platform console requires a Super Admin account."
        />
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
      if (!location.pathname.startsWith('/platform') && location.pathname !== '/settings')
        return <Navigate to="/platform" replace />;
    } else
      return (
        <div className="callback-page">
          <div className="panel p-8">
            <PendingInvitations />
            <h1 className="text-xl">Choose your school</h1>
            {a.me.memberships.length ? (
              a.me.memberships.map((m) => (
                <button
                  key={m.school_id}
                  className="input my-3 text-left"
                  onClick={() => a.setSchool(m.school_id)}
                >
                  {m.school_name}
                </button>
              ))
            ) : (
              <p className="my-3">
                Accept an invitation above, or ask your school administrator to invite you.
              </p>
            )}
            <button className="text-sm underline" onClick={() => a.logout()}>
              Sign out
            </button>
          </div>
        </div>
      );
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
      <Empty
        title="Access unavailable"
        description="Choose a school and use your assigned role's workspace."
      />
    );
  return <Outlet />;
}
function ResourcePage() {
  const { resource } = useParams();
  const a = useAuth();
  if (!resourceNames.includes(resource as Resource)) return <Empty title="Page not found" />;
  const name = resource as Resource;
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
    if (
      !(
        a.me?.school?.role === 'teacher' &&
        name === 'school_holidays' &&
        a.me.school.permissions.includes('classrooms.read')
      )
    )
      return (
        <Empty
          title="This area belongs to another role"
          description="Your school administrator can help with access."
        />
      );
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
      <Route
        path="academics"
        element={
          <Permission code="academics.write">
            <Academics />
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
    </>
  );
}
const router = createBrowserRouter(
  createRoutesFromElements(
    <>
      <Route path="/login" element={<Login />} />
      <Route path="/auth/callback" element={<AuthCallback />} />
      <Route path="/auth/google/callback" element={<GoogleCallback />} />
      <Route element={<Guard />}>
        {schoolRoutes()}
        <Route path=":portal" element={<PortalGate />}>
          {schoolRoutes()}
        </Route>
        {platformSections.map((section) => (
          <Route key={section} path={`platform/${section}`} element={<Platform />} />
        ))}
        <Route path="platform/*" element={<Platform />} />
        <Route
          path="*"
          element={
            <Empty
              title="This page has moved"
              description="Use the workspace navigation to find your way."
            />
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
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Boundary>
      <QueryClientProvider client={client}>
        <AuthProvider>
          <Suspense fallback={<Loading />}>
            <RouterProvider router={router} />
          </Suspense>
        </AuthProvider>
      </QueryClientProvider>
    </Boundary>
  </React.StrictMode>,
);
