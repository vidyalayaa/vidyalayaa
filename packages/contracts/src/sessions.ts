export interface LoginSession {
  id: string;
  device: string;
  browser: string;
  ip_address: string | null;
  location: string | null;
  login_at: string;
  last_active_at: string;
  expires_at: string | null;
  is_current: boolean;
}
export interface AccountSecurityEvent {
  id: string;
  kind: 'NEW_LOGIN' | 'SESSION_ENDED' | 'OTHER_SESSIONS_ENDED' | 'MFA_VERIFIED';
  unfamiliar_network?: boolean;
  affected_count: number;
  created_at: string;
  email_status: 'PENDING' | 'PROCESSING' | 'SENT' | 'FAILED' | 'NOT_REQUIRED';
}
export interface LoginSessionsResponse {
  data: LoginSession[];
  events: AccountSecurityEvent[];
}
