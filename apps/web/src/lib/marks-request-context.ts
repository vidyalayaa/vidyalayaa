import type { Me } from '@vidyalayaa/contracts';

// The API auto-selects a single active membership when X-School-Id is absent.
// Bind the logical school to /me while matching the actual transport selector.
export function marksRequestContext(
  me: Pick<Me, 'id' | 'school' | 'memberships'> | undefined,
  owner: string,
  school: string,
  selected: string,
) {
  if (
    !me ||
    !owner ||
    me.id !== owner ||
    !school ||
    me.school?.school_id !== school ||
    (selected
      ? selected !== school
      : me.memberships.length !== 1 || me.memberships[0].school_id !== school)
  )
    throw new Error(
      'Your account or school changed. Return to the original account and school before retrying these marks.',
    );
  return { userId: owner, schoolId: selected };
}
