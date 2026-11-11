import type { PersonKind } from '@vidyalayaa/contracts';

export function personPhotoPath(school: string, kind: PersonKind, id: string, photo: string) {
  return `${school}/profiles/${kind}/${id}/${photo}.jpg`;
}
