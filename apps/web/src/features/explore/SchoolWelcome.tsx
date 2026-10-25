import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, Compass, LogOut, ShieldCheck } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import PendingInvitations from '../auth/PendingInvitations';
import { ExploreBrand } from './Explore';
import './explore.css';

export default function SchoolWelcome() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  async function signOut() {
    setPending(true);
    setError('');
    try {
      await auth.logout();
      navigate('/login', { replace: true });
    } catch {
      setError('We couldn’t sign you out. Please try again.');
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="school-welcome">
      <header className="explore-container school-welcome-header">
        <ExploreBrand />
        <button
          className="explore-button explore-button-light"
          type="button"
          disabled={pending}
          onClick={signOut}
        >
          <LogOut size={16} />
          {pending ? 'Signing out…' : 'Sign out'}
        </button>
      </header>
      <main className="school-welcome-main">
        <div className="school-welcome-symbol" aria-hidden="true">
          <Compass size={32} />
        </div>
        <p className="explore-eyebrow">YOUR NEXT CHAPTER STARTS HERE</p>
        <h1>
          Welcome to
          <br />
          <span>Vidyalayaa.</span>
        </h1>
        {auth.me?.memberships.length ? (
          <>
            <p className="school-welcome-description">Choose your school to open your workspace.</p>
            <div className="school-welcome-schools">
              {auth.me.memberships.map((membership) => (
                <button
                  className="explore-button explore-button-light"
                  type="button"
                  key={membership.school_id}
                  onClick={() => auth.setSchool(membership.school_id)}
                >
                  {membership.school_name}
                  <ArrowRight size={18} />
                </button>
              ))}
            </div>
          </>
        ) : (
          <p className="school-welcome-description">
            You’re signed in. Your school workspace will be ready once you accept an invitation from
            your School Admin. Until then, discover what a connected school day can look like.
          </p>
        )}
        <Link className="explore-button explore-button-lime" to="/explore">
          Explore Vidyalayaa
          <ArrowRight size={18} />
        </Link>
        <div className="school-welcome-invitations">
          <PendingInvitations />
        </div>
        <p className="school-welcome-note">
          <ShieldCheck size={16} />
          School records are available only through your assigned school and role.
        </p>
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
      </main>
      <footer className="school-welcome-footer">Your school. Your people. In sync.</footer>
    </div>
  );
}
