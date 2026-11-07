import { hashPassword } from './auth.ts';
import { get, insert, run, tx } from './db.ts';

const H = 3600e3;

/** Fictional demo workspace. Everyone here is made up and uses reserved test numbers. */
export function seedDemo() {
  if (!get('SELECT 1 FROM forms LIMIT 1')) {
    insert(
      "INSERT INTO forms(name, body, cta, fields, created_at) VALUES('Book a fitting', 'Grab a fitting slot with us!', 'Book now', ?, ?)",
      JSON.stringify([{ name: 'preferred_day', label: 'Preferred day', type: 'select', options: ['Monday', 'Wednesday', 'Friday'] }, { name: 'shoe_size', label: 'Shoe size', type: 'text' }]), Date.now(),
    );
  }
  if (get('SELECT 1 FROM users LIMIT 1')) return;
  const now = Date.now();
  tx(() => {
    const pass = hashPassword('tripletick');
    const user = (name: string, email: string, role: string, manager: number | null, xp: number, streak: number) =>
      insert('INSERT INTO users(name, email, pass_hash, role, manager_id, xp, streak, created_at) VALUES(?,?,?,?,?,?,?,?)', name, email, pass, role, manager, xp, streak, now);
    const admin = user('Demo Admin', 'demo@tripletick.local', 'admin', null, 420, 3);
    const lead = user('Robin Lead', 'robin@tripletick.local', 'manager', admin, 860, 6);
    const sky = user('Sky Agent', 'sky@tripletick.local', 'agent', lead, 1240, 9);
    const noor = user('Noor Agent', 'noor@tripletick.local', 'agent', lead, 310, 1);
    run("INSERT INTO achievements(user_id, key, at) VALUES(?, 'first_reply', ?), (?, 'speed_demon', ?), (?, 'xp_1000', ?)", sky, now, sky, now, sky, now);

    const sim = insert("INSERT INTO channels(type, name, phone, created_at) VALUES('simulator', 'Simulator: Sales', '+15550100', ?)", now);
    const sim2 = insert("INSERT INTO channels(type, name, phone, created_at) VALUES('simulator', 'Simulator: Support', '+15550101', ?)", now);

    const contact = (name: string, phone: string, email: string, tags: string[], fields: object, optIn = 1) =>
      insert('INSERT INTO contacts(name, phone, email, tags, fields, opted_in, created_at) VALUES(?,?,?,?,?,?,?)', name, phone, email, JSON.stringify(tags), JSON.stringify(fields), optIn, now - 20 * 24 * H);

    const convo = (contactId: number, channelId: number, assignee: number | null, mood: string, script: [string, string, number][], extra: { status?: string; breached?: boolean } = {}) => {
      const c = insert(
        'INSERT INTO conversations(contact_id, channel_id, status, assignee_id, mood, sla_breached, created_at) VALUES(?,?,?,?,?,?,?)',
        contactId, channelId, extra.status ?? 'open', assignee, mood, extra.breached ? 1 : 0, now - 48 * H,
      );
      let lastIn: number | null = null, lastOut: number | null = null, firstIn: number | null = null, firstOut: number | null = null, last = 0, text = '', unread = 0;
      script.forEach(([dir, body, hoursAgo], i) => {
        const at = now - hoursAgo * H;
        const isLast = i === script.length - 1;
        const status = dir === 'in' ? 'read' : script.slice(i + 1).some((s) => s[0] === 'in') ? 'acted' : isLast ? 'read' : 'delivered';
        insert(
          "INSERT INTO messages(conversation_id, direction, body, status, user_id, via, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)",
          c, dir, body, status, dir === 'out' ? assignee : null, dir === 'in' ? 'customer' : 'agent', at,
        );
        if (dir === 'in') { lastIn = at; firstIn ??= at; unread++; } else { lastOut = at; firstOut ??= at; unread = 0; }
        last = at;
        text = body;
      });
      run(
        'UPDATE conversations SET last_inbound_at=?, last_outbound_at=?, first_inbound_at=?, first_response_at=?, last_message_at=?, last_preview=?, unread=?, sla_due_at=?, resolved_at=? WHERE id=?',
        lastIn, lastOut, firstIn, firstOut, last, text.slice(0, 120), unread, firstOut ? null : now + 15 * 60e3, extra.status === 'resolved' ? last : null, c,
      );
    };

    const maya = contact('Maya Fictional', '+15550142', 'maya@example.com', ['vip', 'sneakers'], { city: 'Pune', size: '9' });
    const leo = contact('Leo Testcase', '+15550143', 'leo@example.com', ['refund'], { city: 'Austin' });
    const ines = contact('Ines Sample', '+15550144', 'ines@example.com', ['wholesale'], { city: 'Lisbon' });
    const tomo = contact('Tomo Placeholder', '+15550145', '', ['sneakers'], { city: 'Osaka' });
    const ada = contact('Ada Mockwell', '+15550146', 'ada@example.com', ['vip'], { city: 'Nairobi' });
    contact('Sam Nonesuch', '+15550147', '', ['newsletter'], {}, 0);
    for (let i = 0; i < 18; i++) contact(`Demo Customer ${i + 1}`, `+1555020${String(i).padStart(2, '0')}`, '', i % 2 ? ['sneakers'] : ['newsletter'], {});

    convo(maya, sim, sky, 'happy', [
      ['in', 'Hi! Do you have the Cloud Runner in size 9?', 3],
      ['out', 'Hey Maya! Yes, we have 4 pairs left in size 9 👟', 2.9],
      ['in', 'Amazing, thank you! Can I pick it up today?', 0.2],
    ]);
    convo(leo, sim2, null, 'upset', [
      ['in', 'My order never arrived and it has been two weeks. This is terrible.', 0.1],
    ]);
    convo(ines, sim, noor, 'neutral', [
      ['in', 'What are your wholesale minimums?', 5],
      ['out', 'Hi Ines, our minimum is 24 units per style.', 4.5],
    ]);
    convo(tomo, sim, sky, 'happy', [
      ['in', 'Where is my order #4417?', 40],
      ['out', 'It shipped yesterday, tracking is on its way!', 39],
      ['in', 'Great, thanks!', 38],
      ['out', 'Enjoy them! 🎉', 37.9],
    ], { status: 'resolved' });
    convo(ada, sim2, noor, 'neutral', [
      ['in', 'Do you ship to Nairobi?', 30],
    ], { breached: true });

    const tpl = (name: string, category: string, body: string, vars: string[], buttons: string[]) =>
      insert("INSERT INTO templates(name, category, body, footer, buttons, variables, status, created_at) VALUES(?,?,?,'Reply STOP to unsubscribe',?,?,'APPROVED',?)", name, category, body, JSON.stringify(buttons), JSON.stringify(vars), now);
    tpl('spring_drop', 'MARKETING', 'Hey {{1}}! The spring drop just landed. Want first dibs?', ['first_name'], ['Show me', 'Not now']);
    tpl('order_update', 'UTILITY', 'Hi {{1}}, there is an update on your order. Reply here if you have any questions.', ['first_name'], []);

    run("INSERT INTO quick_replies(shortcut, body) VALUES('hours', 'We are open 9am to 6pm, Monday to Friday.'), ('thanks', 'Thanks so much for reaching out! 💛'), ('returns', 'You can return any unworn pair within 30 days.')");
    insert("INSERT INTO segments(name, match, rules, created_at) VALUES('Sneakerheads', 'all', ?, ?)", JSON.stringify([{ field: 'tag', op: 'equals', value: 'sneakers' }]), now);
    insert("INSERT INTO segments(name, match, rules, created_at) VALUES('VIPs', 'all', ?, ?)", JSON.stringify([{ field: 'tag', op: 'equals', value: 'vip' }]), now);

    insert("INSERT INTO knowledge(title, content, created_at) VALUES('Shipping times', 'Standard shipping takes 3 to 5 business days. Express shipping takes 1 to 2 business days.', ?)", now);
    insert("INSERT INTO knowledge(title, content, created_at) VALUES('Returns and refunds', 'You can return any unworn pair within 30 days for a full refund. Refunds reach your card in 5 business days.', ?)", now);
    insert("INSERT INTO knowledge(title, content, created_at) VALUES('Store hours', 'Our store hours are 9am to 6pm, Monday to Friday.', ?)", now);

    const graph = {
      nodes: [
        { id: 'start', type: 'start', position: { x: 40, y: 160 }, data: {} },
        { id: 'menu', type: 'buttons', position: { x: 280, y: 120 }, data: { text: 'Hey {{first_name}}! What can we do for you?', options: ['Track order', 'Talk to a human'] } },
        { id: 'ask', type: 'question', position: { x: 620, y: 40 }, data: { text: "What's your order number?", saveTo: 'order_number' } },
        { id: 'done', type: 'message', position: { x: 920, y: 40 }, data: { text: 'Thanks! Order {{order_number}} is on the way 🚚' } },
        { id: 'human', type: 'handoff', position: { x: 620, y: 260 }, data: { text: 'Connecting you with the team now!' } },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'menu' },
        { id: 'e2', source: 'menu', sourceHandle: 'opt0', target: 'ask' },
        { id: 'e3', source: 'menu', sourceHandle: 'opt1', target: 'human' },
        { id: 'e4', source: 'ask', target: 'done' },
      ],
    };
    insert("INSERT INTO bots(name, enabled, trigger, graph, created_at) VALUES('Help menu', 1, ?, ?, ?)", JSON.stringify({ type: 'keyword', keywords: ['menu', 'help'] }), JSON.stringify(graph), now);
  });
}
