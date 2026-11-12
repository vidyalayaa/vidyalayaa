import { useState, useEffect } from 'react';
import { Clock, ShieldCheck, Bell, Calendar, Sparkles } from 'lucide-react';
import type { RuleSet } from '@vidyalayaa/contracts';
import { sampleRule } from '../resources/metadata';

const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const;

export default function AttendanceRuleBuilder({
  value,
  onChange,
}: {
  value: string | RuleSet;
  onChange: (value: string) => void;
}) {
  const [rule, setRule] = useState<RuleSet>(() => {
    if (!value) return sampleRule as RuleSet;
    if (typeof value === 'object') return value;
    try {
      return JSON.parse(value);
    } catch {
      return sampleRule as RuleSet;
    }
  });

  useEffect(() => {
    const encoded = JSON.stringify(rule);
    if (typeof value !== 'string' || value !== encoded) onChange(encoded);
  }, [rule, value, onChange]);

  const update = (patch: Partial<RuleSet>) => {
    setRule((prev) => ({ ...prev, ...patch }));
  };

  const updateArrival = (key: keyof RuleSet['arrival'], val: string) => {
    setRule((prev) => ({
      ...prev,
      arrival: { ...prev.arrival, [key]: val },
    }));
  };

  const updateDeparture = (kind: 'half_day' | 'normal', field: 'start' | 'end', val: string) => {
    setRule((prev) => ({
      ...prev,
      departure: {
        ...prev.departure,
        [kind]: { ...prev.departure[kind], [field]: val },
      },
    }));
  };

  const toggleDay = (day: (typeof DAYS)[number]) => {
    setRule((prev) => {
      const exists = prev.weekly_off.includes(day);
      return {
        ...prev,
        weekly_off: exists ? prev.weekly_off.filter((d) => d !== day) : [...prev.weekly_off, day],
      };
    });
  };

  const toggleNotify = (key: keyof RuleSet['notify']) => {
    setRule((prev) => ({
      ...prev,
      notify: { ...prev.notify, [key]: !prev.notify[key] },
    }));
  };

  return (
    <div className="space-y-6 rounded-2xl border border-stone-200 bg-surface p-5 shadow-xs">
      {/* Visual Timeline Bar */}
      <div className="rounded-xl bg-stone-50 p-4 border border-stone-100">
        <div className="flex items-center justify-between text-xs font-semibold text-stone-600 mb-2">
          <span className="flex items-center gap-1.5">
            <Clock size={14} className="text-stone-400" />
            Daily Gate & Attendance Windows
          </span>
          <span className="text-[11px] text-stone-400 font-mono">Cutoff: {rule.absent_cutoff}</span>
        </div>
        <div className="flex h-7 w-full overflow-hidden rounded-lg font-mono text-[10px] font-semibold shadow-inner">
          <div
            className="flex items-center justify-center bg-stone-300 px-2 text-stone-700"
            style={{ flex: 1.5 }}
            title={`Earliest gate open: ${rule.arrival.earliest_accept}`}
          >
            Open {rule.arrival.earliest_accept}
          </div>
          <div
            className="flex items-center justify-center bg-green-50 px-2 text-green-900"
            style={{ flex: 2 }}
            title={`On-time arrival: ${rule.arrival.on_time_start} - ${rule.arrival.on_time_end}`}
          >
            On-time ({rule.arrival.on_time_start}–{rule.arrival.on_time_end})
          </div>
          <div
            className="flex items-center justify-center bg-amber-50 px-2 text-amber-900"
            style={{ flex: 2 }}
            title={`Late window: up to ${rule.arrival.late_end}`}
          >
            Late (–{rule.arrival.late_end})
          </div>
          <div
            className="flex items-center justify-center bg-blue-50 px-2 text-blue-900"
            style={{ flex: 2 }}
            title={`Departure: ${rule.departure.normal.start} - ${rule.departure.normal.end}`}
          >
            Depart ({rule.departure.normal.start})
          </div>
        </div>
      </div>

      {/* Arrival Windows Grid */}
      <div>
        <h4 className="text-xs font-bold uppercase tracking-wider text-stone-500 mb-3">
          1. Morning Arrival Windows
        </h4>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <label className="block text-xs font-medium text-stone-700">
            Earliest Gate Entry
            <input
              type="time"
              className="input mt-1 w-full text-xs font-mono"
              value={rule.arrival.earliest_accept}
              onChange={(e) => updateArrival('earliest_accept', e.target.value)}
              required
            />
          </label>
          <label className="block text-xs font-medium text-stone-700">
            On-Time Start
            <input
              type="time"
              className="input mt-1 w-full text-xs font-mono"
              value={rule.arrival.on_time_start}
              onChange={(e) => updateArrival('on_time_start', e.target.value)}
              required
            />
          </label>
          <label className="block text-xs font-medium text-stone-700">
            On-Time End (Late After)
            <input
              type="time"
              className="input mt-1 w-full text-xs font-mono"
              value={rule.arrival.on_time_end}
              onChange={(e) => updateArrival('on_time_end', e.target.value)}
              required
            />
          </label>
          <label className="block text-xs font-medium text-stone-700">
            Late Entry Cutoff
            <input
              type="time"
              className="input mt-1 w-full text-xs font-mono"
              value={rule.arrival.late_end}
              onChange={(e) => updateArrival('late_end', e.target.value)}
              required
            />
          </label>
        </div>
      </div>

      {/* Departure Windows Grid */}
      <div>
        <h4 className="text-xs font-bold uppercase tracking-wider text-stone-500 mb-3">
          2. Afternoon Departure Windows
        </h4>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <label className="block text-xs font-medium text-stone-700">
            Half-Day Start
            <input
              type="time"
              className="input mt-1 w-full text-xs font-mono"
              value={rule.departure.half_day.start}
              onChange={(e) => updateDeparture('half_day', 'start', e.target.value)}
              required
            />
          </label>
          <label className="block text-xs font-medium text-stone-700">
            Half-Day End
            <input
              type="time"
              className="input mt-1 w-full text-xs font-mono"
              value={rule.departure.half_day.end}
              onChange={(e) => updateDeparture('half_day', 'end', e.target.value)}
              required
            />
          </label>
          <label className="block text-xs font-medium text-stone-700">
            Normal Dismissal Start
            <input
              type="time"
              className="input mt-1 w-full text-xs font-mono"
              value={rule.departure.normal.start}
              onChange={(e) => updateDeparture('normal', 'start', e.target.value)}
              required
            />
          </label>
          <label className="block text-xs font-medium text-stone-700">
            Dismissal Window End
            <input
              type="time"
              className="input mt-1 w-full text-xs font-mono"
              value={rule.departure.normal.end}
              onChange={(e) => updateDeparture('normal', 'end', e.target.value)}
              required
            />
          </label>
        </div>
      </div>

      {/* Weekly Off Days Selector */}
      <div>
        <h4 className="text-xs font-bold uppercase tracking-wider text-stone-500 mb-2">
          3. Weekly Non-Instructional Days (Off)
        </h4>
        <div className="flex flex-wrap gap-2">
          {DAYS.map((day) => {
            const isOff = rule.weekly_off.includes(day);
            return (
              <button
                type="button"
                key={day}
                className={`rounded-lg px-3 py-1.5 text-xs font-bold transition-all ${
                  isOff
                    ? 'bg-rose-100 text-rose-800 border border-rose-300'
                    : 'bg-stone-100 text-stone-600 border border-stone-200 hover:bg-stone-200'
                }`}
                onClick={() => toggleDay(day)}
              >
                {day} {isOff ? '✓' : ''}
              </button>
            );
          })}
        </div>
      </div>

      {/* Policy Tuning & Anti-Passback */}
      <div>
        <h4 className="text-xs font-bold uppercase tracking-wider text-stone-500 mb-3">
          4. Attendance Finalization & Debounce
        </h4>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <label className="block text-xs font-medium text-stone-700">
            Absent Cutoff Time
            <input
              type="time"
              className="input mt-1 w-full text-xs font-mono"
              value={rule.absent_cutoff}
              onChange={(e) => update({ absent_cutoff: e.target.value })}
              required
            />
          </label>
          <label className="block text-xs font-medium text-stone-700">
            Absent Grace (Minutes)
            <input
              type="number"
              min={0}
              max={360}
              className="input mt-1 w-full text-xs"
              value={rule.absent_finalize_grace_minutes}
              onChange={(e) => update({ absent_finalize_grace_minutes: Number(e.target.value) })}
              required
            />
          </label>
          <label className="block text-xs font-medium text-stone-700">
            Tap Debounce (Seconds)
            <input
              type="number"
              min={1}
              max={600}
              className="input mt-1 w-full text-xs"
              value={rule.repeat_tap_debounce_seconds}
              onChange={(e) => update({ repeat_tap_debounce_seconds: Number(e.target.value) })}
              required
            />
          </label>
          <label className="block text-xs font-medium text-stone-700">
            Late Status Counts As
            <select
              className="input mt-1 w-full text-xs"
              value={rule.late_counts_as}
              onChange={(e) => update({ late_counts_as: e.target.value as 'LATE' | 'PRESENT' })}
            >
              <option value="LATE">LATE</option>
              <option value="PRESENT">PRESENT</option>
            </select>
          </label>
        </div>
      </div>

      {/* Parent Notifications */}
      <div>
        <h4 className="text-xs font-bold uppercase tracking-wider text-stone-500 mb-2">
          5. Instant Parent Alert Triggers
        </h4>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {(['arrival', 'late', 'departure', 'absent'] as const).map((kind) => (
            <label
              key={kind}
              className="flex items-center gap-2 rounded-xl border border-stone-200 p-2.5 text-xs font-medium text-stone-700 cursor-pointer hover:bg-stone-50"
            >
              <input
                type="checkbox"
                checked={rule.notify[kind]}
                onChange={() => toggleNotify(kind)}
                className="rounded border-stone-300 text-lime-700 focus:ring-lime-500"
              />
              <span className="capitalize">{kind} Alerts</span>
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}
