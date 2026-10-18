import React, { Suspense, lazy } from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate, useParams, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { resourceNames, type Resource } from '@vidyalayaa/contracts';
import { AuthProvider, configured, useAuth } from './lib/auth';
import Layout from './components/Layout';
import { Loading, ErrorState, Empty } from './components/common';
import { ResourceScreen } from './features/resources/ResourceScreen';
import { resourceInfo } from './features/resources/metadata';
import {
  Attendance,
  Devices,
  Corrections,
  Reports,
  Notifications,
  Members,
  Audit,
  SupportGrants,
} from './features/operations/Screens';

import './styles.css';
const AuthCallback = lazy(() =>
  import('./features/auth/Login').then((m) => ({ default: m.AuthCallback })),
);
const Dashboard = lazy(() => import('./features/dashboard/Dashboard')),
  Login = lazy(() => import('./features/auth/Login')),
  Settings = lazy(() => import('./features/operations/Settings')),
  Platform = lazy(() => import('./features/operations/Platform'));
const client = new QueryClient({
  defaultOptions: { queries: { staleTime: 30000, retry: 1, refetchOnWindowFocus: true } },
});
function Guard() {
  const a = useAuth(),
    location = useLocation();
  if (a.loading) return <Loading />;
  if (configured && !a.session)
    return <Navigate to={`/login?returnTo=${encodeURIComponent(location.pathname)}`} replace />;
  if (a.error) return <ErrorState error={a.error} />;
  if (a.me && !a.me.school) {
    if (a.me.platform_role === 'SUPER_ADMIN') {
      if (!['/platform', '/settings'].includes(location.pathname))
        return <Navigate to="/platform" replace />;
    } else
      return (
        <div className="callback-page">
          <div className="panel p-8">
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
              <p className="my-3">Your administrator needs to add your school membership.</p>
            )}
            <button className="text-sm underline" onClick={() => a.logout()}>
              Sign out
            </button>
          </div>
        </div>
      );
  }
  return <Layout />;
}
function ResourcePage() {
  const { resource } = useParams();
  const a = useAuth();
  if (!resourceNames.includes(resource as Resource)) return <Empty title="Page not found" />;
  const name = resource as Resource;
  if (configured && !a.me?.school?.permissions.includes(resourceInfo[name].permission))
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
  render() {
    return this.state.error ? <ErrorState error={this.state.error} /> : this.props.children;
  }
}
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Boundary>
      <QueryClientProvider client={client}>
        <AuthProvider>
          <BrowserRouter>
            <Suspense fallback={<Loading />}>
              <Routes>
                <Route path="/login" element={<Login />} />
                <Route path="/auth/callback" element={<AuthCallback />} />
                <Route element={<Guard />}>
                  <Route index element={<Dashboard />} />
                  <Route path="r/:resource" element={<ResourcePage />} />
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
                  <Route path="platform" element={<Platform />} />
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
              </Routes>
            </Suspense>
          </BrowserRouter>
        </AuthProvider>
      </QueryClientProvider>
    </Boundary>
  </React.StrictMode>,
);
