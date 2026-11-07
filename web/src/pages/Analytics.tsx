import { useState } from 'react';
import { api } from '../lib/api';
import { duration, Empty, money, MOODS, PageHead, useData } from '../lib/ui';

function Chart({ days }: { days: { day: string; inbound: number; outbound: number }[] }) {
  const W = 760, H = 200, pad = 26;
  const max = Math.max(1, ...days.flatMap((d) => [d.inbound, d.outbound]));
  const slot = (W - pad * 2) / Math.max(days.length, 1);
  const bar = Math.min(16, slot / 2.6);
  const y = (v: number) => (H - pad) - (v / max) * (H - pad * 2);
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Messages per day over ${days.length} days`}>
      <line x1={pad} x2={W - pad} y1={H - pad} y2={H - pad} stroke="var(--border)" />
      <text x={pad - 4} y={y(max) + 4} textAnchor="end">{max}</text>
      {days.map((d, i) => {
        const x = pad + i * slot + slot / 2;
        return (
          <g key={d.day}>
            <rect x={x - bar - 1} y={y(d.inbound)} width={bar} height={H - pad - y(d.inbound)} fill="var(--accent)" rx="2"><title>{d.day}: {d.inbound} in</title></rect>
            <rect x={x + 1} y={y(d.outbound)} width={bar} height={H - pad - y(d.outbound)} fill="var(--muted)" rx="2"><title>{d.day}: {d.outbound} out</title></rect>
            {(days.length <= 14 || i % 5 === 0) && <text x={x} y={H - 8} textAnchor="middle">{d.day.slice(5)}</text>}
          </g>
        );
      })}
    </svg>
  );
}

export function Analytics() {
  const [days, setDays] = useState(14);
  const { data } = useData<any>(() => api.get(`/analytics?days=${days}`), [days], ['conversation']);
  if (!data) return null;
  const t = data.totals;
  const topicMax = Math.max(1, ...data.topics.map((x: any) => x.n));
  return (
    <div className="page">
      <PageHead title="Analytics" sub="How the team and the bots are doing.">
        <label className="sr" htmlFor="range">Date range</label>
        <select id="range" value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ width: 'auto' }}>
          <option value={7}>Last 7 days</option><option value={14}>Last 14 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option>
        </select>
        <a className="btn" href={`/api/analytics/agents.csv?days=${days}`}>Export CSV</a>
      </PageHead>
      <div className="stats">
        {[
          [t.conversations, 'Active conversations'], [duration(t.avgFirstResponseMs), 'Avg first response'], [`${Math.round(t.slaMet * 100)}%`, 'SLA met'],
          [`${Math.round(t.thirdTickRate * 100)}%`, 'Third-tick rate'], [t.automated, 'Automated replies'], [t.resolved, 'Resolved'],
          [`${t.callsCompleted} / ${t.calls}`, 'Calls connected'], [t.callsMissed, 'Missed calls'], [`${t.conversions} · ${money(t.conversionValue)}`, 'Sales logged'],
        ].map(([v, label]) => <div className="card stat" key={label}><b>{v}</b><span>{label}</span></div>)}
      </div>
      <section className="card">
        <h3>Messages per day</h3>
        <div className="legend"><span><i style={{ background: 'var(--accent)' }} />Inbound</span><span><i style={{ background: 'var(--muted)' }} />Outbound</span></div>
        {data.perDay.length ? <Chart days={data.perDay} /> : <Empty emoji="📈" title="No messages in this period" />}
      </section>
      <div className="grid-2">
        <section className="card">
          <h3>Topics (from tags)</h3>
          <div className="funnel">
            {data.topics.map((x: any) => <div key={x.tag}><span>{x.tag}</span><span className="bar"><i style={{ width: `${(x.n / topicMax) * 100}%` }} /></span><span>{x.n}</span></div>)}
            {!data.topics.length && <p className="muted">Tag some chats to see topics here.</p>}
          </div>
        </section>
        <section className="card">
          <h3>Customer mood</h3>
          <div className="stats">{data.moods.map((m: any) => <div className="stat" key={m.mood}><b>{MOODS[m.mood]} {m.n}</b><span>{m.mood}</span></div>)}</div>
        </section>
      </div>
      <section className="card table-wrap">
        <h3>Agent performance</h3>
        <table>
          <thead><tr><th>Agent</th><th>Replies</th><th>Resolved</th><th>Avg first response</th><th>SLA breaches</th></tr></thead>
          <tbody>{data.agents.map((a: any) => <tr key={a.id}><td>{a.name}</td><td>{a.replies}</td><td>{a.resolved}</td><td>{duration(a.avg_first_response)}</td><td>{a.breaches}</td></tr>)}</tbody>
        </table>
      </section>
    </div>
  );
}
