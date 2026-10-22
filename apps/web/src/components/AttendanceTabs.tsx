import { Link } from 'react-router-dom';
import { configured, useAuth } from '../lib/auth';
import { schoolPath } from '../lib/portals';

export type AttendanceTab = 'daily' | 'history' | 'cards' | 'rules' | 'calendar';

export function AttendanceTabs({ active }: { active: AttendanceTab }) {
  const a = useAuth();
  const role = a.me?.school?.role;
  const permissions = a.me?.school?.permissions || [];
  const canAttendance = !configured || permissions.includes('attendance.read');
  const canCards = !configured || permissions.includes('cards.read');
  const canRules = !configured || permissions.includes('rules.read');

  return (
    <div className="tabs [&>a]:shrink-0">
      {canAttendance && (
        <Link
          className={active === 'daily' ? 'tab-active' : ''}
          to={schoolPath('/attendance', role)}
        >
          Daily attendance
        </Link>
      )}
      {canAttendance && (
        <Link
          className={active === 'history' ? 'tab-active' : ''}
          to={schoolPath('/attendance/history', role)}
        >
          Movement history
        </Link>
      )}
      {canCards && (
        <Link
          className={active === 'cards' ? 'tab-active' : ''}
          to={schoolPath('/r/nfc_cards', role)}
        >
          NFC cards
        </Link>
      )}
      {canRules && (
        <Link
          className={active === 'rules' ? 'tab-active' : ''}
          to={schoolPath('/r/attendance_rule_versions', role)}
        >
          Rule versions
        </Link>
      )}
      <Link
        className={active === 'calendar' ? 'tab-active' : ''}
        to={schoolPath('/calendar', role)}
      >
        Calendar
      </Link>
    </div>
  );
}
