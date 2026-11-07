import { api } from '../lib/api';
import { PageHead, useApp, useData } from '../lib/ui';

const MEDALS = ['🥇', '🥈', '🥉'];

export function Leaderboard() {
  const { me } = useApp();
  const { data } = useData<any>(() => api.get('/leaderboard'), [], ['conversation']);
  if (!data) return null;
  const catalog = Object.entries<any>(data.catalog);
  return (
    <div className="page">
      <PageHead title="The Arena" sub="XP for fast, helpful replies. Admins can turn this off in Settings." />
      <section className="card table-wrap">
        <table>
          <thead><tr><th>#</th><th>Agent</th><th>XP</th><th>Streak</th><th>Badges</th></tr></thead>
          <tbody>
            {data.users.map((u: any, i: number) => (
              <tr key={u.id} style={u.id === me.id ? { fontWeight: 700 } : undefined}>
                <td className="rank">{MEDALS[i] ?? i + 1}</td>
                <td>{u.name}</td><td>{u.xp}</td><td>{u.streak ? `🔥 ${u.streak}` : '–'}</td>
                <td>{u.achievements.map((a: string) => <span key={a} title={data.catalog[a]?.name}>{data.catalog[a]?.emoji}</span>)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section>
        <h2>Badges</h2>
        <div className="stats" style={{ marginTop: '.6em' }}>
          {catalog.map(([key, a]) => {
            const got = data.users.find((u: any) => u.id === me.id)?.achievements.includes(key);
            return <div className={`card stat ach ${got ? 'got' : ''}`} key={key}><b>{a.emoji}</b><strong>{a.name}</strong><br /><span>{a.hint}</span></div>;
          })}
        </div>
      </section>
    </div>
  );
}
