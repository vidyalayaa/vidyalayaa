import type { SchoolProfileDetails, SchoolProfileAdmin } from '@vidyalayaa/contracts';
export interface ProfileField {
  key: Exclude<keyof SchoolProfileDetails, 'facilities'>;
  label: string;
  type?: 'email' | 'url' | 'tel' | 'date' | 'textarea';
  max?: number;
}
export const profileGroups: {
  id: string;
  title: string;
  description: string;
  fields: ProfileField[];
}[] = [
  {
    id: 'identity',
    title: 'School identity',
    description: 'Introduce your school to every family.',
    fields: [
      { key: 'tagline', label: 'School tagline' },
      { key: 'motto', label: 'Motto' },
      { key: 'about', label: 'About the school', type: 'textarea', max: 5000 },
      { key: 'established_year', label: 'Established year', max: 4 },
      { key: 'school_type', label: 'School type' },
    ],
  },
  {
    id: 'contact',
    title: 'Address & contact',
    description: 'Use official contact details suitable for students and parents.',
    fields: [
      { key: 'address_line1', label: 'Street address', max: 300 },
      { key: 'address_line2', label: 'Address line 2', max: 300 },
      { key: 'locality', label: 'Locality' },
      { key: 'city', label: 'City' },
      { key: 'district', label: 'District' },
      { key: 'state', label: 'State / region' },
      { key: 'postal_code', label: 'Postal code', max: 20 },
      { key: 'country', label: 'Country' },
      { key: 'email', label: 'School email', type: 'email', max: 254 },
      { key: 'phone', label: 'Official contact number', type: 'tel', max: 40 },
      { key: 'alternate_phone', label: 'Alternate contact number', type: 'tel', max: 40 },
      { key: 'website', label: 'Website', type: 'url', max: 500 },
    ],
  },
  {
    id: 'leadership',
    title: 'Principal',
    description: 'Share the Principal’s name and official office contacts.',
    fields: [
      { key: 'principal_name', label: 'Principal name' },
      { key: 'principal_email', label: 'Principal office email', type: 'email', max: 254 },
      { key: 'principal_phone', label: 'Principal office phone', type: 'tel', max: 40 },
      { key: 'principal_qualification', label: 'Principal qualifications', max: 300 },
    ],
  },
  {
    id: 'affiliation',
    title: 'Affiliation & recognition',
    description: 'Keep the school’s board and recognition information up to date.',
    fields: [
      { key: 'board', label: 'Education board' },
      { key: 'affiliation_number', label: 'Affiliation number' },
      { key: 'recognition_number', label: 'Recognition number' },
      { key: 'recognized_by', label: 'Recognizing authority' },
      { key: 'recognition_valid_until', label: 'Recognition valid until', type: 'date' },
      { key: 'udise_code', label: 'UDISE / school registration code', max: 40 },
    ],
  },
  {
    id: 'academics',
    title: 'Academics & office hours',
    description:
      'School days, lecture timings and breaks use your existing timetable configuration.',
    fields: [
      { key: 'grades_offered', label: 'Grades offered' },
      { key: 'medium', label: 'Medium of instruction' },
      { key: 'academic_pattern', label: 'Academic pattern / curriculum', max: 300 },
      { key: 'office_hours', label: 'School office hours' },
      { key: 'visiting_hours', label: 'Parent visiting hours' },
    ],
  },
  {
    id: 'facilities',
    title: 'Facilities & infrastructure',
    description: 'Describe the facilities and support available at school.',
    fields: [
      { key: 'infrastructure', label: 'Infrastructure details', type: 'textarea', max: 5000 },
      { key: 'accessibility', label: 'Accessibility & inclusion', type: 'textarea', max: 3000 },
      { key: 'transport_information', label: 'Transport information', type: 'textarea', max: 3000 },
    ],
  },
  {
    id: 'safety',
    title: 'Safety & school policies',
    description: 'These official emergency details and policies are visible to school members.',
    fields: [
      { key: 'emergency_phone', label: 'Emergency contact number', type: 'tel', max: 40 },
      {
        key: 'emergency_instructions',
        label: 'Emergency instructions',
        type: 'textarea',
        max: 3000,
      },
      { key: 'policies', label: 'Important school policies', type: 'textarea', max: 12000 },
    ],
  },
];
export const adminFields: {
  key: keyof SchoolProfileAdmin;
  label: string;
  type?: ProfileField['type'];
  max?: number;
}[] = [
  { key: 'management_name', label: 'Management organization' },
  { key: 'management_contact_name', label: 'Management contact person' },
  { key: 'management_email', label: 'Management email', type: 'email', max: 254 },
  { key: 'management_phone', label: 'Management contact number', type: 'tel', max: 40 },
  { key: 'management_address', label: 'Management address', type: 'textarea', max: 1000 },
  {
    key: 'internal_emergency_contacts',
    label: 'Internal emergency contacts',
    type: 'textarea',
    max: 4000,
  },
  {
    key: 'internal_policies',
    label: 'Internal policies & management notes',
    type: 'textarea',
    max: 10000,
  },
];
export const facilityOptions = [
  'Library',
  'Science laboratory',
  'Computer laboratory',
  'Sports ground',
  'Auditorium',
  'Medical room',
  'Counselling',
  'Drinking water',
  'Accessible toilets',
  'Wheelchair access',
  'CCTV',
  'School transport',
  'Cafeteria',
  'Hostel',
];
