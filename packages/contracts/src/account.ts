export interface AccountCredentials {
  email: string;
  has_password: boolean;
  pending_email: string | null;
  email_confirmed: boolean;
}
