import { NavLink } from 'react-router-dom';
import { configured, useAuth } from '../../lib/auth';
import { schoolPath } from '../../lib/portals';

const links = [
  ['students', 'Students', 'students.read'],
  ['parents', 'Parents & Guardians', 'parents.read'],
  ['student_parents', 'Family Connections', 'parents.read'],
] as const;

export default function StudentRecordTabs() {
  const { me } = useAuth();
  return (
    <nav className="tabs" aria-label="Student records">
      {links
        .filter(([, , permission]) => !configured || me?.school?.permissions.includes(permission))
        .map(([resource, label]) => (
          <NavLink
            key={resource}
            to={schoolPath('/r/' + resource, me?.school?.role)}
            className={({ isActive }) => (isActive ? 'tab-active' : '')}
          >
            {label}
          </NavLink>
        ))}
    </nav>
  );
}
