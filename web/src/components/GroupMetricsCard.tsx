import type { ReactNode } from 'react';
import type { GroupMetrics, Pair } from '../api';
import { dateTime, duration, fullDate, plural, sinceLabel, untilLabel } from '../format';

/**
 * Each group gets the metrics that matter for it: keeping in touch with
 * close friends, balance and momentum with a romantic interest, the lead-up
 * to a date, and the shape of a silence.
 */
export function GroupMetricsCard({ metrics, now }: { metrics: GroupMetrics; now: number }) {
  switch (metrics.group) {
    case 'close':
      return (
        <section className="card group-card group-close">
          <h3>Keeping in touch</h3>
          <Headline>
            {metrics.lastAt === null ? 'No messages yet' : `Last talked ${sinceLabel(metrics.lastAt, now)} ago`}
            {metrics.overdue && <span className="pill pill-warn">Longer than usual</span>}
          </Headline>
          <Row label="You usually talk every">{metrics.usualGapMs === null ? '—' : duration(metrics.usualGapMs)}</Row>
          <Split label="Who reaches out (90 days)" pair={metrics.initiations} format={(n) => plural(n, 'time')} />
          <Row label="Messages a week">
            <Trend recent={metrics.perWeek.recent} previous={metrics.perWeek.previous} unit="" decimals={1} />
          </Row>
          <Row label="Streak">
            {plural(metrics.streakDays.current, 'day')} now · best {plural(metrics.streakDays.longest, 'day')}
          </Row>
        </section>
      );

    case 'romantic':
      return (
        <section className="card group-card group-romantic">
          <h3>Interest signals · 30 days</h3>
          <Headline>{ballInCourt(metrics.lastFrom, metrics.lastAt, now)}</Headline>
          <Split label="Who starts conversations" pair={metrics.initiations} format={(n) => plural(n, 'time')} />
          <Row label="Reply time">
            You {fmtMs(metrics.medianReplyMs.you)} · Them {fmtMs(metrics.medianReplyMs.them)}
          </Row>
          {metrics.theirReplyTrend.recent !== null && metrics.theirReplyTrend.previous !== null && (
            <Row label="Their replies this week">
              {speedWord(metrics.theirReplyTrend.recent, metrics.theirReplyTrend.previous)}:{' '}
              {duration(metrics.theirReplyTrend.recent)} vs {duration(metrics.theirReplyTrend.previous)} before
            </Row>
          )}
          <Split label="Words per message" pair={metrics.wordsPerMessage} format={(n) => n.toFixed(1)} />
          <Split label="Questions asked" pair={metrics.questions} format={String} />
          <Split label="Double texts" pair={metrics.doubleTexts} format={String} />
          <Row label="This week">
            <Trend recent={metrics.momentum.recent} previous={metrics.momentum.previous} unit=" messages" />
          </Row>
          {metrics.afterDate && (
            <Row label={`After your date (${fullDate(metrics.afterDate.dateAt)})`}>
              {metrics.afterDate.firstAt === null
                ? 'No messages since'
                : `${metrics.afterDate.firstFrom === 'you' ? 'You' : 'They'} texted first, ${dateTime(metrics.afterDate.firstAt)}`}
            </Row>
          )}
        </section>
      );

    case 'dates':
      return (
        <section className="card group-card group-dates">
          <h3>Your date</h3>
          <Headline>
            {dateTime(metrics.dateAt)}
            <span className="pill">{metrics.dateAt > now ? untilLabel(metrics.dateAt, now) : 'happening now'}</span>
          </Headline>
          <Row label="Since you scheduled it">{plural(metrics.sinceScheduled.messages, 'message')}</Row>
          <Split
            label="Who’s been reaching out"
            pair={metrics.sinceScheduled.initiations}
            format={(n) => plural(n, 'time')}
          />
          <Row label="Lead-up">
            <Trend
              recent={metrics.leadUp.recentPerDay}
              previous={metrics.leadUp.beforePerDay}
              unit=" a day"
              decimals={1}
            />
          </Row>
          <Row label="Last message">{ballInCourt(metrics.lastFrom, metrics.lastAt, now)}</Row>
        </section>
      );

    case 'ghosts':
      return (
        <section className="card group-card group-ghosts">
          <h3>The silence</h3>
          <Headline>Silent for {sinceLabel(metrics.silentSinceAt, now)}</Headline>
          <Row label="Waiting on">
            {metrics.lastFrom === null
              ? '—'
              : metrics.lastFrom === 'you'
                ? `Them · ${plural(metrics.unanswered, 'message')} of yours unanswered`
                : `You · they sent the last ${metrics.unanswered === 1 ? 'message' : plural(metrics.unanswered, 'message')}`}
          </Row>
          <Row label={metrics.lastFrom === 'you' ? 'They usually replied in' : 'You usually replied in'}>
            {fmtMs(metrics.usualReplyMs)}
          </Row>
          {metrics.lastExchange.length > 0 && (
            <div className="last-exchange" aria-label="How it ended">
              {metrics.lastExchange.map((m, i) => (
                <p key={i} className={m.fromSelf ? 'mine' : 'theirs'}>
                  {m.text || '…'}
                </p>
              ))}
            </div>
          )}
          <Row label="Talking since">
            {metrics.firstAt === null ? '—' : `${fullDate(metrics.firstAt)} · ${plural(metrics.total, 'message')}`}
          </Row>
        </section>
      );
  }
}

function fmtMs(ms: number | null): string {
  return ms === null ? '—' : duration(ms);
}

function ballInCourt(lastFrom: 'you' | 'them' | null, lastAt: number | null, now: number): string {
  if (lastFrom === null) return 'No messages yet';
  const ago = `${sinceLabel(lastAt, now)} ago`;
  return lastFrom === 'them' ? `Your move: they wrote last, ${ago}` : `Waiting on them: you wrote last, ${ago}`;
}

function Headline({ children }: { children: ReactNode }) {
  return <p className="group-headline">{children}</p>;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="metric-row">
      <span className="metric-label">{label}</span>
      <span className="metric-value">{children}</span>
    </div>
  );
}

/** You vs them as a two-part bar: you are always the first series colour, them the second. */
function Split({ label, pair, format }: { label: string; pair: Pair; format: (n: number) => string }) {
  const total = pair.you + pair.them;
  return (
    <div className="metric-split">
      <div className="metric-row">
        <span className="metric-label">{label}</span>
        <span className="metric-value">
          You {format(pair.you)} · Them {format(pair.them)}
        </span>
      </div>
      {total > 0 && (
        <div
          className="split-bar"
          role="img"
          aria-label={`You ${Math.round((pair.you / total) * 100)}%, them ${Math.round((pair.them / total) * 100)}%`}
        >
          {pair.you > 0 && <span style={{ flexGrow: pair.you, background: 'var(--series-1)' }} />}
          {pair.them > 0 && <span style={{ flexGrow: pair.them, background: 'var(--series-2)' }} />}
        </div>
      )}
    </div>
  );
}

/** Within this many percent, a change reads as "about the same" rather than up or down. */
const STEADY_PCT = 10;

function speedWord(recent: number, previous: number): string {
  const change = ((recent - previous) / previous) * 100;
  if (Math.abs(change) < STEADY_PCT) return 'About the same';
  return change < 0 ? 'Faster' : 'Slower';
}

function Trend({
  recent,
  previous,
  unit,
  decimals = 0,
}: {
  recent: number;
  previous: number;
  unit: string;
  decimals?: number;
}) {
  const fmt = (n: number) => n.toFixed(decimals);
  if (previous === 0) {
    return (
      <>
        {fmt(recent)}
        {unit}
      </>
    );
  }
  const change = Math.round(((recent - previous) / previous) * 100);
  const direction = Math.abs(change) < STEADY_PCT ? 'steady' : change > 0 ? 'up' : 'down';
  return (
    <>
      {fmt(recent)}
      {unit}{' '}
      <span className={`trend ${direction}`}>
        {direction === 'steady' ? '≈ same' : `${direction === 'up' ? '↑' : '↓'} ${Math.abs(change)}%`}
      </span>{' '}
      <span className="metric-sub">vs {fmt(previous)} before</span>
    </>
  );
}
