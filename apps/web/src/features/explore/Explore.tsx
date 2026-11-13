import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  CalendarDays,
  Check,
  ChevronRight,
  ClipboardCheck,
  GraduationCap,
  HeartHandshake,
  Layers3,
  Lightbulb,
  ListChecks,
  Menu,
  MessagesSquare,
  Radio,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  Users,
  Wallet,
  X,
} from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { ThemeSelect } from '../../components/ThemeSelect';
import './explore.css';

const roles = [
  {
    name: 'School Admin',
    label: 'A little less admin. A lot more clarity.',
    description:
      'Bring students, staff, academics, and school operations into one organized workspace.',
    tools: [
      'Student & family records',
      'Classes & teacher assignments',
      'Fees & school communication',
    ],
    Icon: Layers3,
    focus: 'Your school, connected',
    steps: [
      'Organize classes & sections',
      'Connect students with families',
      'Keep the school day moving',
    ],
  },
  {
    name: 'Principal',
    label: 'See the school beyond the paperwork.',
    description:
      'Follow attendance, academic records, and school updates with a clear view of the day.',
    tools: [
      'School overview',
      'Attendance insights',
      'Academic records & reports',
      'AI insights across classes & subjects',
    ],
    Icon: GraduationCap,
    focus: 'The bigger picture',
    steps: [
      'Review school attendance',
      'Follow academic progress with AI insights',
      'Stay close to school updates',
    ],
  },
  {
    name: 'Teacher',
    label: 'More room for what you do best.',
    description:
      'Find your assigned classes, share homework, and follow student progress in one place.',
    tools: [
      'Assigned classes & students',
      'Homework & subject tests',
      'Timetable & attendance',
      'AI class performance insights',
    ],
    Icon: BookOpen,
    focus: 'Your teaching day',
    steps: ['Check your weekly timetable', 'Share class homework', 'Record subject test marks'],
  },
  {
    name: 'Parent',
    label: 'Stay close to their school day.',
    description:
      'Follow your linked children’s learning, attendance, and important school information.',
    tools: [
      'Your children’s attendance',
      'Homework & published results',
      'Fees, events & school updates',
      'AI guidance on your child’s results',
    ],
    Icon: HeartHandshake,
    focus: 'A stronger school–home connection',
    steps: [
      'Follow your child’s attendance',
      'Keep up with homework',
      'See relevant school events',
    ],
  },
  {
    name: 'Student',
    label: 'Your school day, all together.',
    description: 'Know what is next, keep up with your class, and see your own learning records.',
    tools: [
      'Your class timetable',
      'Homework & published results',
      'School calendar & updates',
      'AI study plan & academic assistant',
    ],
    Icon: GraduationCap,
    focus: 'Ready for the school day',
    steps: ['See your next class', 'Check your homework', 'Follow your weekly AI study plan'],
  },
];

const aiFeatures = [
  {
    Icon: TrendingUp,
    tag: 'PERFORMANCE ANALYSIS',
    name: 'See what the results are saying.',
    text: 'Subject-by-subject strengths, priorities, and changes since earlier exams, explained in plain language.',
  },
  {
    Icon: Lightbulb,
    tag: 'RECOMMENDATIONS',
    name: 'Know where to focus next.',
    text: 'Realistic short- and long-term goals, with optional guidance built only from published results.',
  },
  {
    Icon: ListChecks,
    tag: 'WEEKLY STUDY PLAN',
    name: 'A week of study, already planned.',
    text: 'Bite-sized daily activities across subjects. Students tick each one off as they go.',
  },
  {
    Icon: MessagesSquare,
    tag: 'AI ACADEMIC ASSISTANT',
    name: 'Ask about your results.',
    text: '“Which subject needs more attention?” “Am I improving?” Get a short, clear answer.',
  },
];

const aiPlan = [
  ['Mon', 'English', 30, 'Read a short passage and summarize it', true],
  ['Tue', 'Maths', 25, 'Practise ten mixed problems', true],
  ['Wed', 'Computer', 20, 'Revise key terms with flashcards', false],
  ['Thu', 'English', 30, 'Write one paragraph and self-check', false],
] as const;

// Keep these factual: 4 learner tools + staff insights; plans span Mon–Sun;
// AI reaches students, parents, teachers, principals, and school admins.
const aiStats = [
  ['5', 'AI tools built in'],
  ['7-day', 'personal study plans'],
  ['5', 'school roles with AI'],
  ['0', 'student names shared with the AI'],
] as const;

const aiFlow = [
  ['Results are published', 'Teachers publish exam marks exactly as they do today.'],
  [
    'AI reads the numbers',
    'Only marks and percentages are analysed. Never names or personal details.',
  ],
  [
    'Everyone gets next steps',
    'Analysis, goals, a weekly plan, and answers, right in the workspace.',
  ],
] as const;

const aiTrust = [
  'Uses published results only',
  'Never changes official marks, grades, or ranks',
  'Student names and typed questions are not sent to the AI',
  'Guidance is optional and flags when evidence is thin',
];

const features = [
  {
    Icon: Sparkles,
    name: 'Results, explained by AI.',
    text: 'Performance analysis, focused recommendations, weekly study plans, and an academic assistant, built from published results.',
    tag: 'AI GUIDANCE',
    className: 'explore-feature-ai',
  },
  {
    Icon: ClipboardCheck,
    name: 'Attendance, with a clear trail.',
    text: 'Daily attendance, NFC-enabled check-ins, and movement history help schools keep track of the day.',
    tag: 'ATTENDANCE & NFC',
    className: 'explore-feature-attendance',
  },
  {
    Icon: BookOpen,
    name: 'Learning stays connected.',
    text: 'Classes, subjects, homework, timetables, and published results give each learner a clearer path.',
    tag: 'ACADEMICS',
    className: '',
  },
  {
    Icon: HeartHandshake,
    name: 'Keep families in the loop.',
    text: 'Linked parent accounts bring relevant school updates and student information closer to home.',
    tag: 'SCHOOL & HOME',
    className: '',
  },
  {
    Icon: Wallet,
    name: 'The everyday, organized.',
    text: 'Manage fee records, school calendars, and targeted notifications alongside your school’s core records.',
    tag: 'SCHOOL OPERATIONS',
    className: 'explore-feature-operations',
  },
];

export function ExploreBrand() {
  return (
    <Link to="/explore" className="brand explore-brand">
      <span className="brand-symbol" aria-hidden="true">
        v<span />
      </span>
      <span>vidyalayaa.</span>
      <span className="sr-only">Explore home</span>
    </Link>
  );
}

export default function Explore() {
  const auth = useAuth();
  const [activeRole, setActiveRole] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const role = roles[activeRole];
  const entryLabel = auth.session ? 'Back to workspace' : 'Sign in';
  const entryPath = auth.session ? '/' : '/login';

  useEffect(() => {
    const title = document.title;
    document.title = 'Explore Vidyalayaa | The AI-powered school platform';
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries)
          if (entry.isIntersecting) {
            entry.target.classList.add('explore-visible');
            observer.unobserve(entry.target);
          }
      },
      { threshold: 0.08 },
    );
    root.current?.querySelectorAll('[data-reveal]').forEach((element) => observer.observe(element));
    return () => {
      document.title = title;
      observer.disconnect();
    };
  }, []);

  return (
    <div className="explore-page" ref={root}>
      <a className="explore-skip" href="#explore-main">
        Skip to content
      </a>
      <header className="explore-header">
        <div className="explore-announcement">
          <span className="explore-live-dot" /> A connected school. A calmer day.
          <a className="explore-announcement-link" href="#ai">
            <Sparkles size={13} /> New: AI study plans & result insights
            <ArrowRight size={12} />
          </a>
        </div>
        <div className="explore-container explore-header-inner">
          <ExploreBrand />
          <nav className="explore-desktop-nav" aria-label="Explore navigation">
            <a className="explore-nav-ai" href="#ai">
              <Sparkles size={13} /> AI guidance
            </a>
            <a href="#people">For your people</a>
            <a href="#features">The platform</a>
            <a href="#getting-started">Getting started</a>
          </nav>
          <div className="flex items-center gap-2">
            <ThemeSelect compact />
            <Link className="explore-button explore-button-dark explore-header-cta" to={entryPath}>
              {entryLabel}
              <ArrowUpRight size={16} />
            </Link>
            <button
              className="explore-menu-button"
              type="button"
              aria-label={menuOpen ? 'Close navigation' : 'Open navigation'}
              aria-expanded={menuOpen}
              aria-controls="explore-mobile-nav"
              onClick={() => setMenuOpen(!menuOpen)}
            >
              {menuOpen ? <X /> : <Menu />}
            </button>
          </div>
        </div>
        {menuOpen && (
          <nav
            id="explore-mobile-nav"
            className="explore-mobile-nav"
            aria-label="Mobile explore navigation"
          >
            {[
              ['#ai', 'AI guidance'],
              ['#people', 'For your people'],
              ['#features', 'The platform'],
              ['#getting-started', 'Getting started'],
            ].map(([href, name]) => (
              <a key={href} href={href} onClick={() => setMenuOpen(false)}>
                {name}
                <ChevronRight size={16} />
              </a>
            ))}
            <Link to={entryPath} onClick={() => setMenuOpen(false)}>
              {entryLabel}
              <ArrowUpRight size={16} />
            </Link>
          </nav>
        )}
      </header>

      <main id="explore-main" tabIndex={-1}>
        <section className="explore-hero explore-container" aria-labelledby="explore-title">
          <div className="explore-hero-copy">
            <p className="explore-ai-badge">
              <Sparkles size={14} /> THE AI-POWERED SCHOOL PLATFORM
            </p>
            <h1 id="explore-title">
              School life.
              <br />
              Connected.
              <br />
              <span className="explore-ai-gradient">Smarter with AI.</span>
            </h1>
            <p className="explore-intro">
              One home for your school’s people, learning, and everyday details, with built-in AI
              that turns published results into clear analysis and a weekly study plan.
            </p>
            <div className="explore-hero-actions">
              <a className="explore-button explore-button-lime" href="#ai">
                <Sparkles size={17} />
                See the AI in action
                <ArrowRight size={18} />
              </a>
              <a className="explore-text-link" href="#people">
                Find your place
                <ArrowDown size={16} />
              </a>
            </div>
            <p className="explore-hero-note">
              <ShieldCheck size={15} /> AI guidance built in. School records kept behind sign-in.
            </p>
          </div>
          <div className="explore-hero-art" aria-label="Illustration of a connected school day">
            <div className="explore-orbit" aria-hidden="true" />
            <span className="explore-art-spark" aria-hidden="true">
              ✳
            </span>
            <div className="explore-day-card">
              <div className="explore-preview-top">
                <span className="explore-mini-brand">v.</span>
                <span>A LITTLE MORE CONNECTED</span>
                <span className="explore-live-dot" />
              </div>
              <h2>
                A good day starts
                <br />
                with a clear view.
              </h2>
              <div className="explore-day-date">
                <CalendarDays size={16} /> A school day, together <span>Illustrative preview</span>
              </div>
              <div className="explore-day-row">
                <span className="explore-icon-tile">
                  <ClipboardCheck size={20} />
                </span>
                <div>
                  <strong>Every arrival matters.</strong>
                  <p>Attendance & school check-ins</p>
                </div>
                <Check size={17} />
              </div>
              <div className="explore-day-row">
                <span className="explore-icon-tile explore-icon-lilac">
                  <BookOpen size={20} />
                </span>
                <div>
                  <strong>Make space for learning.</strong>
                  <p>Classes, homework & results</p>
                </div>
                <Check size={17} />
              </div>
              <div className="explore-day-row">
                <span className="explore-icon-tile explore-icon-peach">
                  <HeartHandshake size={20} />
                </span>
                <div>
                  <strong>Keep home close.</strong>
                  <p>Parents, students & school updates</p>
                </div>
                <Check size={17} />
              </div>
              <div className="explore-day-row explore-day-row-ai">
                <span className="explore-icon-tile explore-icon-ai">
                  <Sparkles size={20} />
                </span>
                <div>
                  <strong>Know what to study next.</strong>
                  <p>AI analysis & weekly study plans</p>
                </div>
                <Check size={17} />
              </div>
              <div className="explore-card-footer">
                <span className="explore-avatar-stack" aria-hidden="true">
                  <i>
                    <GraduationCap size={16} />
                  </i>
                  <i>
                    <BookOpen size={16} />
                  </i>
                  <i>
                    <HeartHandshake size={16} />
                  </i>
                </span>
                <span>Different roles. A shared school day.</span>
              </div>
            </div>
            <div className="explore-floating-note explore-floating-ai">
              <span>
                <Sparkles size={19} />
              </span>
              <div>
                <strong>Your AI study plan is ready.</strong>
                <small>7 activities this week</small>
              </div>
            </div>
            <div className="explore-floating-note">
              <span>
                <Radio size={19} />
              </span>
              <div>
                <strong>One tap. A clearer picture.</strong>
                <small>NFC-enabled attendance</small>
              </div>
            </div>
          </div>
        </section>

        <div className="explore-values">
          <div className="explore-container">
            {[
              { Icon: Sparkles, text: 'AI guidance, built in' },
              { Icon: Users, text: 'People, connected' },
              { Icon: BookOpen, text: 'Learning, organized' },
              { Icon: CalendarDays, text: 'Everyday, simplified' },
              { Icon: ShieldCheck, text: 'Access, thoughtfully managed' },
            ].map(({ Icon, text }) => {
              return (
                <span key={text}>
                  <Icon size={18} />
                  {text}
                </span>
              );
            })}
          </div>
        </div>

        <section id="ai" className="explore-ai-band" aria-labelledby="explore-ai-title">
          <div className="explore-container explore-section" data-reveal>
            <div className="explore-ai-intro">
              <p className="explore-ai-badge">
                <Sparkles size={14} /> ACADEMIC INTELLIGENCE
              </p>
              <h2 id="explore-ai-title">
                Your school’s AI.
                <br />
                <span className="explore-ai-gradient">Built right in.</span>
              </h2>
              <p>
                Published results become clear analysis, focused recommendations, a weekly study
                plan, and answers to everyday questions, for learners, families, and teachers alike.
              </p>
            </div>

            <dl className="explore-ai-stats">
              {aiStats.map(([value, label]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>

            <ol className="explore-ai-flow">
              {aiFlow.map(([title, text], i) => (
                <li key={title}>
                  <span>0{i + 1}</span>
                  <h3>{title}</h3>
                  <p>{text}</p>
                </li>
              ))}
            </ol>

            <div className="explore-ai-layout">
              <div className="explore-ai-grid">
                {aiFeatures.map(({ Icon, tag, name, text }) => (
                  <article key={tag} className="explore-ai-card">
                    <div className="explore-feature-top">
                      <span className="explore-icon-tile">
                        <Icon size={20} />
                      </span>
                      <span>{tag}</span>
                    </div>
                    <h3>{name}</h3>
                    <p>{text}</p>
                  </article>
                ))}
                <article className="explore-ai-card explore-ai-card-staff">
                  <div className="explore-feature-top">
                    <span className="explore-icon-tile explore-icon-lilac">
                      <Users size={20} />
                    </span>
                    <span>FOR SCHOOL STAFF</span>
                  </div>
                  <h3>Spot trends across the school.</h3>
                  <p>
                    School Admins, Principals, and Teachers get AI summaries of class, subject, and
                    session performance to plan academic support where it matters most.
                  </p>
                </article>
              </div>

              <figure className="explore-ai-preview">
                <div className="explore-preview-top">
                  <span>MY AI STUDY PLAN</span>
                  <Sparkles size={18} />
                </div>
                <h4>This week, a little at a time.</h4>
                <div className="explore-ai-progress" aria-hidden="true">
                  <span style={{ width: '50%' }} />
                </div>
                <p className="explore-ai-progress-label">2 of 4 activities done</p>
                <ul className="explore-ai-plan">
                  {aiPlan.map(([day, subject, minutes, activity, done]) => (
                    <li key={day} className={done ? 'explore-ai-done' : ''}>
                      <span className="explore-ai-check" aria-hidden="true">
                        {done && <Check size={12} strokeWidth={3} />}
                      </span>
                      <div>
                        <strong>
                          <span className="sr-only">{done ? 'Done: ' : 'To do: '}</span>
                          {activity}
                        </strong>
                        <small>
                          {day} · {subject} · {minutes} min
                        </small>
                      </div>
                    </li>
                  ))}
                </ul>
                <div className="explore-ai-chat">
                  <p className="explore-ai-question">Which subject needs more attention?</p>
                  <p className="explore-ai-answer">
                    <Sparkles size={13} />
                    English is your current priority at 55%. Short daily reading practice is a good
                    place to start.
                  </p>
                </div>
                <figcaption className="explore-preview-caption">
                  Illustrative preview · Sample data, not a real student.
                </figcaption>
              </figure>
            </div>
            <div className="explore-ai-trust">
              <ShieldCheck size={26} />
              <div>
                <h3>AI that knows its limits.</h3>
                <ul>
                  {aiTrust.map((item) => (
                    <li key={item}>
                      <Check size={14} />
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </section>

        <section
          id="people"
          className="explore-section explore-container"
          aria-labelledby="explore-people-title"
          data-reveal
        >
          <div className="explore-section-heading">
            <div>
              <p className="explore-eyebrow">ONE SCHOOL. MANY PERSPECTIVES.</p>
              <h2 id="explore-people-title">
                A place for
                <br />
                <span>everyone in the story.</span>
              </h2>
            </div>
            <p>
              A school works best when its people feel connected. Discover what Vidyalayaa brings to
              your day.
            </p>
          </div>
          <div className="explore-role-buttons" role="group" aria-label="Choose a role to explore">
            {roles.map((item, index) => (
              <button
                key={item.name}
                type="button"
                aria-pressed={index === activeRole}
                onClick={() => setActiveRole(index)}
              >
                <item.Icon size={16} />
                {item.name}
              </button>
            ))}
          </div>
          <div className="explore-role-panel" aria-live="polite" aria-atomic="true">
            <div className="explore-role-copy">
              <span className="explore-role-label">FOR {role.name.toUpperCase()}</span>
              <h3>{role.label}</h3>
              <p>{role.description}</p>
              <ul>
                {role.tools.map((tool) => (
                  <li key={tool}>
                    <Check size={16} />
                    {tool}
                  </li>
                ))}
              </ul>
              <a className="explore-text-link" href="#getting-started">
                How to join your school
                <ArrowRight size={16} />
              </a>
            </div>
            <div className="explore-role-preview" key={role.name}>
              <div className="explore-preview-top">
                <span>YOUR {role.name.toUpperCase()} WORKSPACE</span>
                <role.Icon size={20} />
              </div>
              <h4>{role.focus}</h4>
              <div className="explore-preview-rule" />
              {role.steps.map((step, i) => (
                <div className="explore-preview-step" key={step}>
                  <span>0{i + 1}</span>
                  <p>{step}</p>
                  <ChevronRight size={16} />
                </div>
              ))}
              <p className="explore-preview-caption">
                Feature preview · Your school controls access and availability.
              </p>
            </div>
          </div>
          <p className="explore-role-footnote">
            Class Teachers manage manual attendance and official results for their designated
            classes. Subject Teachers work within their assigned classes and subjects.
          </p>
        </section>

        <section
          id="features"
          className="explore-features-section"
          aria-labelledby="explore-features-title"
        >
          <div className="explore-container explore-section" data-reveal>
            <div className="explore-section-heading">
              <div>
                <p className="explore-eyebrow">THE LITTLE DETAILS. THE BIG PICTURE.</p>
                <h2 id="explore-features-title">
                  Less juggling.
                  <br />
                  <span>More school.</span>
                </h2>
              </div>
              <p>
                Bring the essentials of school life together, with the right information in the
                right hands.
              </p>
            </div>
            <div className="explore-features-grid">
              {features.map(({ Icon, name, text, tag, className }) => (
                <article key={tag} className={`explore-feature ${className}`}>
                  <div className="explore-feature-top">
                    <Icon size={27} strokeWidth={1.5} />
                    <span>{tag}</span>
                  </div>
                  <h3>{name}</h3>
                  <p>{text}</p>
                  {tag === 'ATTENDANCE & NFC' && (
                    <div className="explore-attendance-art" aria-hidden="true">
                      {Array.from({ length: 42 }, (_, i) => (
                        <i
                          key={i}
                          className={i % 7 === 5 || i % 11 === 0 ? 'explore-attendance-soft' : ''}
                        />
                      ))}
                    </div>
                  )}
                  {tag === 'AI GUIDANCE' && (
                    <a
                      className="explore-button explore-button-lime explore-feature-ai-link"
                      href="#ai"
                    >
                      See the AI in action
                      <ArrowUpRight size={16} />
                    </a>
                  )}
                  {tag === 'SCHOOL OPERATIONS' && (
                    <div className="explore-operations-tags" aria-hidden="true">
                      <span>School calendar</span>
                      <span>Fee records</span>
                      <span>Notifications</span>
                    </div>
                  )}
                </article>
              ))}
            </div>
          </div>
        </section>

        <section
          id="getting-started"
          className="explore-section explore-container"
          aria-labelledby="explore-start-title"
          data-reveal
        >
          <div className="explore-section-heading">
            <div>
              <p className="explore-eyebrow">YOUR NEXT CHAPTER STARTS HERE</p>
              <h2 id="explore-start-title">
                Find your school.
                <br />
                <span>Feel right at home.</span>
              </h2>
            </div>
            <p>
              Exploring is open to everyone. Your school workspace opens when your account has the
              right invitation and role.
            </p>
          </div>
          <ol className="explore-steps">
            {[
              [
                'Connect with your school',
                'Ask your School Admin to add your details and invite the email address you use.',
              ],
              [
                'Accept your invitation',
                'Sign in, review your school invitation, and accept your assigned role.',
              ],
              [
                'Make yourself at home',
                'Open your workspace to see the classes, records, and updates available to you.',
              ],
            ].map(([title, text], i) => (
              <li key={title}>
                <span className="explore-step-number">
                  0{i + 1}
                  <ArrowUpRight size={20} />
                </span>
                <h3>{title}</h3>
                <p>{text}</p>
              </li>
            ))}
          </ol>
          <div className="explore-security-strip">
            <ShieldCheck size={26} />
            <div>
              <h3>Connected doesn’t mean open to everyone.</h3>
              <p>
                School records stay behind sign-in and role-based access. Parents see their linked
                children’s information, and students see their permitted records.
              </p>
            </div>
          </div>
        </section>

        <section
          className="explore-faq-section explore-container"
          aria-labelledby="explore-faq-title"
          data-reveal
        >
          <div>
            <p className="explore-eyebrow">A LITTLE CLARITY</p>
            <h2 id="explore-faq-title">
              Good questions.
              <br />
              Thoughtful answers.
            </h2>
          </div>
          <div className="explore-faq-list">
            {[
              [
                'Can I explore without an account?',
                'Yes. This page is public. You can explore the platform and its role previews without signing in. No private school records are displayed here.',
              ],
              [
                'I signed in. Why can’t I see my school yet?',
                'Signing in verifies your identity. Your School Admin must invite you and connect your account to the correct school records. Check your invitation email or return to your workspace to accept a pending invitation.',
              ],
              [
                'Can I choose my own role?',
                'Your school assigns your role and access. Selecting a role in this preview only explains its features; it does not change your account or grant access.',
              ],
              [
                'How does the AI use school data?',
                'AI guidance works only from published marks and percentages. Student names and personal details are never sent. Questions typed into the assistant are matched to academic topics; the text itself is not sent. The AI never changes official marks, grades, or ranks, and class averages appear only when your school chooses to share them.',
              ],
              [
                'How can my school get started?',
                'Contact the Vidyalayaa team using the email link below to discuss school onboarding. Existing school members should contact their own School Admin for invitations and account access.',
              ],
            ].map(([question, answer]) => (
              <details key={question}>
                <summary>
                  {question}
                  <span aria-hidden="true">+</span>
                </summary>
                <p>{answer}</p>
              </details>
            ))}
          </div>
        </section>

        <section
          className="explore-container explore-cta"
          aria-labelledby="explore-cta-title"
          data-reveal
        >
          <div>
            <p className="explore-eyebrow">A CONNECTED SCHOOL. A CALMER DAY.</p>
            <h2 id="explore-cta-title">
              Let’s bring your
              <br />
              school together.
            </h2>
            <p>For the people who make a school, every day. With AI guidance built in.</p>
          </div>
          <div className="explore-cta-actions">
            <a
              className="explore-button explore-button-lime"
              href="mailto:vidyalayaainfo@gmail.com?subject=Vidyalayaa%20school%20onboarding"
            >
              Talk to Vidyalayaa
              <ArrowUpRight size={18} />
            </a>
            <Link className="explore-cta-signin" to={entryPath}>
              {auth.session ? 'Return to your account' : 'Already part of a school? Sign in'}
              <ArrowRight size={16} />
            </Link>
          </div>
          <span className="explore-cta-symbol" aria-hidden="true" />
        </section>
      </main>
      <footer className="explore-footer explore-container">
        <ExploreBrand />
        <p>Your school. Your people. In sync.</p>
        <a href="mailto:vidyalayaainfo@gmail.com">
          Say hello
          <ArrowUpRight size={14} />
        </a>
        <span>© {new Date().getFullYear()} Vidyalayaa</span>
      </footer>
    </div>
  );
}
