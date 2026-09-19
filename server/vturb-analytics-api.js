const express = require('express');

module.exports = function createVturbAnalyticsRouter(db) {
  const router = express.Router();

  function vturbAuth(req, res, next) {
    const vturbPaths = [
      '/conversions', '/events', '/times', '/clicks',
      '/headlines', '/turbo', '/sessions', '/traffic_origin',
      '/players', '/custom_metrics', '/comparison_groups', '/quota'
    ];
    if (!vturbPaths.some(p => req.path === p || req.path.startsWith(p + '/'))) {
      return next();
    }

    const token = req.headers['x-api-token'] || (req.headers['authorization'] ? req.headers['authorization'].replace(/^Bearer\s+/i, '') : null);
    const version = req.headers['x-api-version'] || req.query['api_version'] || 'v1';

    if (!token || !version || (version !== 'v1' && version !== '1')) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Missing proper X-Api-Token or X-Api-Version'
      });
    }

    const keyRecord = db.prepare('SELECT * FROM api_keys WHERE token = ?').get(token);
    if (!keyRecord) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Missing proper X-Api-Token or X-Api-Version'
      });
    }

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(keyRecord.user_id);
    if (!user) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'User account not found'
      });
    }

    const now = new Date();
    const oneMinAgo = new Date(now.getTime() - 60000).toISOString();
    const recentQueries = db.prepare('SELECT COUNT(*) as count FROM api_quota_logs WHERE api_key_id = ? AND timestamp >= ?').get(keyRecord.id, oneMinAgo).count;
    const limitPerMinute = user.quota_limit || 60;

    if (recentQueries >= limitPerMinute) {
      const resetTime = new Date(Math.ceil(now.getTime() / 60000) * 60000).toISOString();
      return res.status(429).json({
        error: 'Query quota exceeded for this API key.',
        code: 201,
        details: {
          limit_kind: 'queries',
          used: recentQueries,
          limit: limitPerMinute,
          remaining: 0,
          interval_seconds: 60,
          resets_at: resetTime
        }
      });
    }

    try {
      db.prepare('INSERT INTO api_quota_logs (api_key_id, timestamp, queries_count, read_bytes) VALUES (?, ?, ?, ?)').run(keyRecord.id, now.toISOString(), 1, 1024);
      db.prepare('UPDATE api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?').run(keyRecord.id);
    } catch (e) {}

    req.apiUser = user;
    req.apiKey = keyRecord;
    next();
  }

  router.use(vturbAuth);

  function parseDateFilter(startDate, endDate, prefix = 'created_at') {
    let where = '1=1';
    const params = [];
    if (startDate) {
      where += ` AND ${prefix} >= ?`;
      params.push(startDate.replace('T', ' ').slice(0, 19));
    }
    if (endDate) {
      where += ` AND ${prefix} <= ?`;
      params.push(endDate.replace('T', ' ').slice(0, 19));
    }
    return { where, params };
  }

  function getUserVideoFilter(user, alias = '') {
    const col = alias ? `${alias}.video_id` : 'video_id';
    return {
      sql: `${col} IN (SELECT id FROM videos WHERE user_id = ?)`,
      params: [user.id]
    };
  }

  router.post('/conversions/active_platforms', (req, res) => {
    const { where, params } = parseDateFilter(req.body.start_date, req.body.end_date);
    const uFilter = getUserVideoFilter(req.apiUser);
    const rows = db.prepare(`
      SELECT DISTINCT platform FROM analytics_events
      WHERE ${uFilter.sql} AND platform IS NOT NULL AND platform != '' AND ${where}
    `).all(...uFilter.params, ...params);
    const platforms = rows.map(r => r.platform);
    res.json(platforms);
  });

  router.post('/conversions/stats_by_day', (req, res) => {
    const { player_id, start_date, end_date } = req.body;
    const { where, params } = parseDateFilter(start_date, end_date);
    let targetSql = 'event_type = "conversion"';
    const queryParams = [];

    if (player_id) {
      targetSql += ' AND video_id = ?';
      queryParams.push(player_id);
    } else {
      const uFilter = getUserVideoFilter(req.apiUser);
      targetSql += ` AND ${uFilter.sql}`;
      queryParams.push(...uFilter.params);
    }

    const rows = db.prepare(`
      SELECT
        strftime('%Y-%m-%d', created_at) as date_key,
        COUNT(*) as total_events,
        COUNT(DISTINCT visitor_id) as total_uniq_device_events,
        COUNT(DISTINCT session_id) as total_uniq_session_events,
        SUM(CASE WHEN conversion_currency = 'USD' THEN conversion_amount ELSE conversion_amount * 0.20 END) as total_amount_usd,
        SUM(CASE WHEN conversion_currency = 'BRL' THEN conversion_amount ELSE conversion_amount * 5.00 END) as total_amount_brl,
        SUM(CASE WHEN conversion_currency = 'EUR' THEN conversion_amount ELSE conversion_amount * 0.18 END) as total_amount_eur
      FROM analytics_events
      WHERE ${targetSql} AND ${where}
      GROUP BY date_key
      ORDER BY date_key ASC
    `).all(...queryParams, ...params);

    let totEvents = 0, totDev = 0, totSess = 0, totUsd = 0, totBrl = 0, totEur = 0;
    const eventsByDay = rows.map(r => {
      totEvents += r.total_events || 0;
      totDev += r.total_uniq_device_events || 0;
      totSess += r.total_uniq_session_events || 0;
      totUsd += r.total_amount_usd || 0;
      totBrl += r.total_amount_brl || 0;
      totEur += r.total_amount_eur || 0;
      return {
        date_key: r.date_key,
        total_events: r.total_events || 0,
        total_uniq_device_events: r.total_uniq_device_events || 0,
        total_uniq_session_events: r.total_uniq_session_events || 0,
        total_amount_usd: Number((r.total_amount_usd || 0).toFixed(2)),
        total_amount_brl: Number((r.total_amount_brl || 0).toFixed(2)),
        total_amount_eur: Number((r.total_amount_eur || 0).toFixed(2))
      };
    });

    res.json({
      events_by_day: eventsByDay,
      total_events: totEvents,
      total_uniq_device_events: totDev,
      total_uniq_session_events: totSess,
      total_amount_usd: Number(totUsd.toFixed(2)),
      total_amount_brl: Number(totBrl.toFixed(2)),
      total_amount_eur: Number(totEur.toFixed(2))
    });
  });

  router.post('/conversions/video_timed', (req, res) => {
    const { player_id, start_date, end_date } = req.body;
    const { where, params } = parseDateFilter(start_date, end_date);
    const targetSql = player_id ? 'video_id = ?' : getUserVideoFilter(req.apiUser).sql;
    const qParams = player_id ? [player_id] : getUserVideoFilter(req.apiUser).params;

    const rows = db.prepare(`
      SELECT CAST(ROUND(watch_time) as INTEGER) as timed, COUNT(DISTINCT visitor_id) as total_users
      FROM analytics_events
      WHERE event_type = 'conversion' AND ${targetSql} AND ${where}
      GROUP BY timed
      ORDER BY timed ASC
    `).all(...qParams, ...params);

    const totalUsers = rows.reduce((sum, r) => sum + (r.total_users || 0), 0);
    res.json({
      conversions_timed: rows,
      total_users: totalUsers
    });
  });

  router.post('/events/total_by_company', (req, res) => {
    const { start_date, end_date, events } = req.body;
    const targetEvents = Array.isArray(events) && events.length ? events : ['started', 'viewed', 'finished'];
    const { where, params } = parseDateFilter(start_date, end_date);
    const uFilter = getUserVideoFilter(req.apiUser);

    const result = {};
    for (const ev of targetEvents) {
      let eventTypeCondition = 'event_type = ?';
      if (ev === 'started' || ev === 'play') eventTypeCondition = "(event_type = 'play' OR event_type = 'started')";
      else if (ev === 'viewed') eventTypeCondition = "(event_type = 'page_view' OR event_type = 'viewed')";
      else if (ev === 'finished') eventTypeCondition = "(event_type = 'complete' OR (event_type = 'progress' AND milestone = 100))";

      const stats = db.prepare(`
        SELECT
          COUNT(*) as total,
          COUNT(DISTINCT visitor_id) as total_uniq_device,
          COUNT(DISTINCT session_id) as total_uniq_sessions
        FROM analytics_events
        WHERE ${uFilter.sql} AND ${eventTypeCondition} AND ${where}
      `).get(...uFilter.params, ...params);

      result[ev] = {
        total: stats.total || 0,
        total_uniq_device: stats.total_uniq_device || 0,
        total_uniq_sessions: stats.total_uniq_sessions || 0
      };
    }

    res.json(result);
  });

  router.post('/events/total_by_company_players', (req, res) => {
    const { start_date, end_date, events, player_ids } = req.body;
    const targetEvents = Array.isArray(events) && events.length ? events : ['started', 'viewed', 'finished'];
    const { where, params } = parseDateFilter(start_date, end_date);

    let vids = [];
    if (Array.isArray(player_ids) && player_ids.length) {
      vids = db.prepare(`SELECT id FROM videos WHERE user_id = ? AND id IN (${player_ids.map(() => '?').join(',')})`).all(req.apiUser.id, ...player_ids);
    } else {
      vids = db.prepare('SELECT id FROM videos WHERE user_id = ?').all(req.apiUser.id);
    }

    const payload = vids.map(v => {
      const item = { player_id: v.id };
      for (const ev of targetEvents) {
        let eventTypeCondition = 'event_type = ?';
        if (ev === 'started' || ev === 'play') eventTypeCondition = "(event_type = 'play' OR event_type = 'started')";
        else if (ev === 'viewed') eventTypeCondition = "(event_type = 'page_view' OR event_type = 'viewed')";
        else if (ev === 'finished') eventTypeCondition = "(event_type = 'complete' OR (event_type = 'progress' AND milestone = 100))";

        const stats = db.prepare(`
          SELECT
            COUNT(*) as total,
            COUNT(DISTINCT visitor_id) as total_uniq_device,
            COUNT(DISTINCT session_id) as total_uniq_sessions
          FROM analytics_events
          WHERE video_id = ? AND ${eventTypeCondition} AND ${where}
        `).get(v.id, ...params);

        item[ev] = {
          total: stats.total || 0,
          total_uniq_device: stats.total_uniq_device || 0,
          total_uniq_sessions: stats.total_uniq_sessions || 0
        };
      }
      return item;
    });

    res.json(payload);
  });

  router.post('/events/total_by_company_day', (req, res) => {
    const { start_date, end_date, events } = req.body;
    const targetEvents = Array.isArray(events) && events.length ? events : ['started', 'viewed', 'finished'];
    const { where, params } = parseDateFilter(start_date, end_date);
    const uFilter = getUserVideoFilter(req.apiUser);

    const dates = db.prepare(`
      SELECT DISTINCT strftime('%Y-%m-%d', created_at) as date_key
      FROM analytics_events
      WHERE ${uFilter.sql} AND ${where}
      ORDER BY date_key ASC
    `).all(...uFilter.params, ...params);

    const result = dates.map(d => {
      const item = { date_key: d.date_key };
      for (const ev of targetEvents) {
        let eventTypeCondition = 'event_type = ?';
        if (ev === 'started' || ev === 'play') eventTypeCondition = "(event_type = 'play' OR event_type = 'started')";
        else if (ev === 'viewed') eventTypeCondition = "(event_type = 'page_view' OR event_type = 'viewed')";
        else if (ev === 'finished') eventTypeCondition = "(event_type = 'complete' OR (event_type = 'progress' AND milestone = 100))";

        const stats = db.prepare(`
          SELECT
            COUNT(*) as total,
            COUNT(DISTINCT visitor_id) as total_uniq_device,
            COUNT(DISTINCT session_id) as total_uniq_sessions
          FROM analytics_events
          WHERE ${uFilter.sql} AND strftime('%Y-%m-%d', created_at) = ? AND ${eventTypeCondition}
        `).get(...uFilter.params, d.date_key);

        item[ev] = {
          total: stats.total || 0,
          total_uniq_device: stats.total_uniq_device || 0,
          total_uniq_sessions: stats.total_uniq_sessions || 0
        };
      }
      return item;
    });

    res.json(result);
  });

  router.post('/events/leaderboard', (req, res) => {
    const leaderboards = Array.isArray(req.body.leaderboards) ? req.body.leaderboards : [];
    const response = [];

    for (const lb of leaderboards) {
      const limit = lb.leaderboard_limit || 10;
      const ev = lb.event || 'finished';
      const { where, params } = parseDateFilter(lb.start_date, lb.end_date);
      const uFilter = getUserVideoFilter(req.apiUser);

      let evCond = 'event_type = ?';
      if (ev === 'started' || ev === 'play') evCond = "(event_type = 'play' OR event_type = 'started')";
      else if (ev === 'viewed') evCond = "(event_type = 'page_view' OR event_type = 'viewed')";
      else if (ev === 'finished') evCond = "(event_type = 'complete' OR (event_type = 'progress' AND milestone = 100))";
      else if (ev === 'clicked') evCond = "event_type = 'cta_clicked'";
      else if (ev === 'paused') evCond = "event_type = 'pause'";

      const rows = db.prepare(`
        SELECT
          video_id as player_id,
          COUNT(*) as total_plays,
          COUNT(DISTINCT session_id) as uniq_plays,
          COUNT(DISTINCT visitor_id) as uniq_device_plays
        FROM analytics_events
        WHERE ${uFilter.sql} AND ${evCond} AND ${where}
        GROUP BY video_id
        ORDER BY total_plays DESC
        LIMIT ?
      `).all(...uFilter.params, ...params, limit);

      response.push({
        leaderboard_name: `leaderboard_${limit}`,
        event: ev,
        leaderboards: rows
      });
    }

    res.json(response);
  });

  router.post('/times/user_engagement', (req, res) => {
    const { player_id, video_duration = 3600, start_date, end_date } = req.body;
    if (!player_id) return res.status(400).json({ error: 'player_id is required' });

    const { where, params } = parseDateFilter(start_date, end_date);
    const watchRows = db.prepare(`
      SELECT watch_time, visitor_id, session_id
      FROM analytics_events
      WHERE video_id = ? AND watch_time > 0 AND ${where}
    `).all(player_id, ...params);

    const totalUsers = db.prepare(`
      SELECT COUNT(DISTINCT session_id) as count
      FROM analytics_events
      WHERE video_id = ? AND (event_type = 'play' OR event_type = 'started' OR watch_time > 0) AND ${where}
    `).get(player_id, ...params).count || 1;

    const maxSec = Math.min(Math.round(video_duration), 7200);
    const step = maxSec > 600 ? 5 : 1;
    const groupedTimed = [];

    for (let t = 0; t <= maxSec; t += step) {
      const usersAtT = watchRows.filter(r => r.watch_time >= t).length;
      groupedTimed.push({ timed: t, total_users: usersAtT });
    }

    const avgWatch = watchRows.length ? (watchRows.reduce((a, b) => a + b.watch_time, 0) / watchRows.length) : 0;
    const engRate = video_duration > 0 ? Number(((avgWatch / video_duration) * 100).toFixed(2)) : 0;

    res.json({
      average_watched_time: Number(avgWatch.toFixed(1)),
      engagement_rate: engRate,
      grouped_timed: groupedTimed,
      total_users: totalUsers
    });
  });

  router.post('/times/user_engagement_by_day', (req, res) => {
    const { player_id, video_duration = 3600, start_date, end_date } = req.body;
    if (!player_id) return res.status(400).json({ error: 'player_id is required' });

    const { where, params } = parseDateFilter(start_date, end_date);
    const rows = db.prepare(`
      SELECT
        strftime('%Y-%m-%d', created_at) as date_key,
        AVG(watch_time) as average_watched_time,
        COUNT(DISTINCT session_id) as total_users
      FROM analytics_events
      WHERE video_id = ? AND watch_time > 0 AND ${where}
      GROUP BY date_key
      ORDER BY date_key ASC
    `).all(player_id, ...params);

    const out = rows.map(r => ({
      date_key: r.date_key,
      average_watched_time: Number((r.average_watched_time || 0).toFixed(1)),
      engagement_rate: video_duration > 0 ? Number((((r.average_watched_time || 0) / video_duration) * 100).toFixed(2)) : 0,
      total_users: r.total_users || 0,
      total_video_duration: video_duration
    }));

    res.json(out);
  });

  router.post('/times/user_engagement_by_field', (req, res) => {
    const { player_id, field = 'country', video_duration = 3600, start_date, end_date } = req.body;
    if (!player_id) return res.status(400).json({ error: 'player_id is required' });

    const allowed = ['country', 'device', 'browser', 'os'];
    const safeField = allowed.includes(field) ? field : 'country';
    const { where, params } = parseDateFilter(start_date, end_date);

    const rows = db.prepare(`
      SELECT
        COALESCE(${safeField}, 'Unknown') as grouped_field,
        AVG(watch_time) as average_watched_time,
        COUNT(DISTINCT session_id) as total_users
      FROM analytics_events
      WHERE video_id = ? AND ${where}
      GROUP BY grouped_field
      ORDER BY total_users DESC
    `).all(player_id, ...params);

    const out = rows.map(r => ({
      grouped_field: r.grouped_field,
      average_watched_time: Number((r.average_watched_time || 0).toFixed(1)),
      engagement_rate: video_duration > 0 ? Number((((r.average_watched_time || 0) / video_duration) * 100).toFixed(2)) : 0,
      total_users: r.total_users || 0,
      total_video_duration: video_duration
    }));

    res.json(out);
  });

  router.post('/times/user_engagement_by_traffic_origin', (req, res) => {
    const { player_id, traffic_field = 'utm_source', video_duration = 3600, start_date, end_date } = req.body;
    if (!player_id) return res.status(400).json({ error: 'player_id is required' });

    const allowed = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'domain'];
    const safeField = allowed.includes(traffic_field) ? traffic_field : 'utm_source';
    const { where, params } = parseDateFilter(start_date, end_date);

    const rows = db.prepare(`
      SELECT
        COALESCE(${safeField}, 'direto') as grouped_field,
        AVG(watch_time) as average_watched_time,
        COUNT(DISTINCT session_id) as total_users
      FROM analytics_events
      WHERE video_id = ? AND ${where}
      GROUP BY grouped_field
      ORDER BY total_users DESC
    `).all(player_id, ...params);

    const out = rows.map(r => ({
      grouped_field: r.grouped_field,
      average_watched_time: Number((r.average_watched_time || 0).toFixed(1)),
      engagement_rate: video_duration > 0 ? Number((((r.average_watched_time || 0) / video_duration) * 100).toFixed(2)) : 0,
      total_users: r.total_users || 0,
      total_video_duration: video_duration
    }));

    res.json(out);
  });

  router.post('/clicks/total_by_company_timed', (req, res) => {
    const { player_id, start_date, end_date } = req.body;
    const { where, params } = parseDateFilter(start_date, end_date);
    const targetSql = player_id ? 'video_id = ?' : getUserVideoFilter(req.apiUser).sql;
    const qParams = player_id ? [player_id] : getUserVideoFilter(req.apiUser).params;

    const rows = db.prepare(`
      SELECT CAST(ROUND(watch_time) as INTEGER) as timed, COUNT(*) as total_users
      FROM analytics_events
      WHERE event_type = 'cta_clicked' AND ${targetSql} AND ${where}
      GROUP BY timed
      ORDER BY timed ASC
    `).all(...qParams, ...params);

    const totalClicks = rows.reduce((s, r) => s + (r.total_users || 0), 0);
    res.json({
      clicks_timed: rows,
      total_users: totalClicks
    });
  });

  router.post('/clicks/total_by_company_day', (req, res) => {
    const { player_id, start_date, end_date } = req.body;
    const { where, params } = parseDateFilter(start_date, end_date);
    const targetSql = player_id ? 'video_id = ?' : getUserVideoFilter(req.apiUser).sql;
    const qParams = player_id ? [player_id] : getUserVideoFilter(req.apiUser).params;

    const rows = db.prepare(`
      SELECT
        strftime('%Y-%m-%d', created_at) as date_key,
        COUNT(*) as total,
        COUNT(DISTINCT visitor_id) as total_uniq_device,
        COUNT(DISTINCT session_id) as total_uniq_sessions
      FROM analytics_events
      WHERE event_type = 'cta_clicked' AND ${targetSql} AND ${where}
      GROUP BY date_key
      ORDER BY date_key ASC
    `).all(...qParams, ...params);

    let totClicks = 0, totDev = 0, totSess = 0;
    rows.forEach(r => {
      totClicks += r.total || 0;
      totDev += r.total_uniq_device || 0;
      totSess += r.total_uniq_sessions || 0;
    });

    res.json({
      events_by_day: rows,
      total_clicks: totClicks,
      total_uniq_device_clicks: totDev,
      total_uniq_sessions_clicks: totSess
    });
  });

  function getHeadlineOrTurboStats(req, res) {
    const { player_id, start_date, end_date } = req.body;
    if (!player_id) return res.status(400).json({ error: 'player_id is required' });

    const { where, params } = parseDateFilter(start_date, end_date);
    const views = db.prepare(`SELECT COUNT(*) as c FROM analytics_events WHERE video_id = ? AND event_type = 'page_view' AND ${where}`).get(player_id, ...params).c || 0;
    const plays = db.prepare(`SELECT COUNT(*) as c FROM analytics_events WHERE video_id = ? AND event_type = 'play' AND ${where}`).get(player_id, ...params).c || 0;
    const convRow = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN conversion_currency = 'BRL' THEN conversion_amount ELSE conversion_amount * 5.0 END) as total_brl,
        SUM(CASE WHEN conversion_currency = 'USD' THEN conversion_amount ELSE conversion_amount * 0.20 END) as total_usd,
        SUM(CASE WHEN conversion_currency = 'EUR' THEN conversion_amount ELSE conversion_amount * 0.18 END) as total_eur
      FROM analytics_events
      WHERE video_id = ? AND event_type = 'conversion' AND ${where}
    `).get(player_id, ...params);

    const playRate = views > 0 ? Number(((plays / views) * 100).toFixed(2)) : 0;
    res.json({
      total_views: views,
      total_plays: plays,
      play_rate: playRate,
      conversions: {
        total: convRow.total || 0,
        total_amount_brl: Number((convRow.total_brl || 0).toFixed(2)),
        total_amount_usd: Number((convRow.total_usd || 0).toFixed(2)),
        total_amount_eur: Number((convRow.total_eur || 0).toFixed(2))
      }
    });
  }

  router.post('/headlines/stats_by_player', getHeadlineOrTurboStats);
  router.post('/turbo/stats_by_player', getHeadlineOrTurboStats);

  function calculateSessionMetrics(playerId, startDate, endDate, videoDuration = 3600, pitchTime = 30) {
    const { where, params } = parseDateFilter(startDate, endDate);
    const baseParams = [playerId, ...params];

    const viewed = db.prepare(`SELECT COUNT(*) as tot, COUNT(DISTINCT visitor_id) as dev, COUNT(DISTINCT session_id) as sess FROM analytics_events WHERE video_id = ? AND event_type = 'page_view' AND ${where}`).get(...baseParams);
    const started = db.prepare(`SELECT COUNT(*) as tot, COUNT(DISTINCT visitor_id) as dev, COUNT(DISTINCT session_id) as sess FROM analytics_events WHERE video_id = ? AND event_type = 'play' AND ${where}`).get(...baseParams);
    const finished = db.prepare(`SELECT COUNT(*) as tot, COUNT(DISTINCT visitor_id) as dev, COUNT(DISTINCT session_id) as sess FROM analytics_events WHERE video_id = ? AND (event_type = 'complete' OR (event_type = 'progress' AND milestone = 100)) AND ${where}`).get(...baseParams);
    const clicked = db.prepare(`SELECT COUNT(*) as tot, COUNT(DISTINCT visitor_id) as dev, COUNT(DISTINCT session_id) as sess FROM analytics_events WHERE video_id = ? AND event_type = 'cta_clicked' AND ${where}`).get(...baseParams);

    const overPitch = db.prepare(`SELECT COUNT(DISTINCT session_id) as c FROM analytics_events WHERE video_id = ? AND (watch_time >= ? OR event_type = 'pitch_viewed') AND ${where}`).get(playerId, pitchTime, ...params).c || 0;
    const underPitch = Math.max(0, (started.sess || 0) - overPitch);
    const overPitchRate = started.sess > 0 ? Number(((overPitch / started.sess) * 100).toFixed(2)) : 0;

    const conv = db.prepare(`
      SELECT
        COUNT(*) as tot,
        SUM(CASE WHEN conversion_currency = 'USD' THEN conversion_amount ELSE conversion_amount * 0.20 END) as usd,
        SUM(CASE WHEN conversion_currency = 'BRL' THEN conversion_amount ELSE conversion_amount * 5.0 END) as brl,
        SUM(CASE WHEN conversion_currency = 'EUR' THEN conversion_amount ELSE conversion_amount * 0.18 END) as eur
      FROM analytics_events WHERE video_id = ? AND event_type = 'conversion' AND ${where}
    `).get(...baseParams);

    const avgWatch = db.prepare(`SELECT AVG(watch_time) as a FROM analytics_events WHERE video_id = ? AND watch_time > 0 AND ${where}`).get(...baseParams).a || 0;
    const engRate = videoDuration > 0 ? Number(((avgWatch / videoDuration) * 100).toFixed(2)) : 0;
    const playRate = viewed.tot > 0 ? Number(((started.tot / viewed.tot) * 100).toFixed(2)) : 0;
    const convRate = viewed.tot > 0 ? Number((((conv.tot || 0) / viewed.tot) * 100).toFixed(2)) : 0;

    return {
      total_viewed: viewed.tot || 0,
      total_viewed_device_uniq: viewed.dev || 0,
      total_viewed_session_uniq: viewed.sess || 0,
      total_started: started.tot || 0,
      total_started_session_uniq: started.sess || 0,
      total_started_device_uniq: started.dev || 0,
      total_finished: finished.tot || 0,
      total_finished_session_uniq: finished.sess || 0,
      total_finished_device_uniq: finished.dev || 0,
      engagement_rate: engRate,
      total_clicked: clicked.tot || 0,
      total_clicked_device_uniq: clicked.dev || 0,
      total_clicked_session_uniq: clicked.sess || 0,
      total_over_pitch: overPitch,
      total_under_pitch: underPitch,
      over_pitch_rate: overPitchRate,
      total_conversions: conv.tot || 0,
      overall_conversion_rate: convRate,
      total_amount_usd: Number((conv.usd || 0).toFixed(2)),
      total_amount_brl: Number((conv.brl || 0).toFixed(2)),
      total_amount_eur: Number((conv.eur || 0).toFixed(2)),
      play_rate: playRate
    };
  }

  router.post('/sessions/stats', (req, res) => {
    const { player_id, start_date, end_date, video_duration = 3600, pitch_time = 30 } = req.body;
    if (!player_id) return res.status(400).json({ error: 'player_id is required' });
    const stats = calculateSessionMetrics(player_id, start_date, end_date, video_duration, pitch_time);
    res.json(stats);
  });

  router.post('/sessions/stats_by_day', (req, res) => {
    const { player_id, start_date, end_date, video_duration = 3600, pitch_time = 30 } = req.body;
    if (!player_id) return res.status(400).json({ error: 'player_id is required' });

    const { where, params } = parseDateFilter(start_date, end_date);
    const dates = db.prepare(`
      SELECT DISTINCT strftime('%Y-%m-%d', created_at) as date_key
      FROM analytics_events
      WHERE video_id = ? AND ${where}
      ORDER BY date_key ASC
    `).all(player_id, ...params);

    const out = dates.map(d => {
      const dayMetrics = calculateSessionMetrics(player_id, d.date_key + ' 00:00:00', d.date_key + ' 23:59:59', video_duration, pitch_time);
      return { date_key: d.date_key, ...dayMetrics };
    });

    res.json(out);
  });

  router.post('/sessions/stats_by_field', (req, res) => {
    const { player_id, field = 'country', start_date, end_date, video_duration = 3600, pitch_time = 30 } = req.body;
    if (!player_id) return res.status(400).json({ error: 'player_id is required' });

    const allowed = ['country', 'device', 'browser', 'os'];
    const safeField = allowed.includes(field) ? field : 'country';
    const { where, params } = parseDateFilter(start_date, end_date);

    const groups = db.prepare(`
      SELECT DISTINCT COALESCE(${safeField}, 'Unknown') as val
      FROM analytics_events
      WHERE video_id = ? AND ${where}
    `).all(player_id, ...params);

    const out = groups.map(g => {
      const metrics = calculateSessionMetrics(player_id, start_date, end_date, video_duration, pitch_time);
      return { grouped_field: g.val, ...metrics };
    });

    res.json(out);
  });

  router.post('/sessions/stats_by_field_by_day', (req, res) => {
    const { player_id, field = 'country', start_date, end_date, video_duration = 3600, pitch_time = 30 } = req.body;
    if (!player_id) return res.status(400).json({ error: 'player_id is required' });

    const allowed = ['country', 'device', 'browser', 'os'];
    const safeField = allowed.includes(field) ? field : 'country';
    const { where, params } = parseDateFilter(start_date, end_date);

    const combinations = db.prepare(`
      SELECT DISTINCT
        strftime('%Y-%m-%d', created_at) as date_key,
        COALESCE(${safeField}, 'Unknown') as grouped_field
      FROM analytics_events
      WHERE video_id = ? AND ${where}
      ORDER BY date_key ASC
    `).all(player_id, ...params);

    const out = combinations.map(c => {
      const metrics = calculateSessionMetrics(player_id, c.date_key + ' 00:00:00', c.date_key + ' 23:59:59', video_duration, pitch_time);
      return { date_key: c.date_key, grouped_field: c.grouped_field, ...metrics };
    });

    res.json(out);
  });

  router.get('/sessions/live_users', (req, res) => {
    const playerId = req.query.player_id;
    const minutes = Math.max(1, Math.min(720, parseInt(req.query.minutes, 10) || 60));

    if (!playerId) {
      return res.status(400).json({ error: 'player_id is required' });
    }

    const cutoff = new Date(Date.now() - minutes * 60000).toISOString();
    const rows = db.prepare(`
      SELECT COALESCE(domain, 'direto') as domain, COUNT(DISTINCT session_id) as live_users
      FROM analytics_events
      WHERE video_id = ? AND created_at >= ?
      GROUP BY domain
      ORDER BY live_users DESC
    `).all(playerId, cutoff);

    res.json(rows);
  });

  router.post('/traffic_origin/stats', (req, res) => {
    const { player_id, traffic_field = 'utm_source', start_date, end_date, video_duration = 3600, pitch_time = 30 } = req.body;
    if (!player_id) return res.status(400).json({ error: 'player_id is required' });

    const allowed = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'domain'];
    const safeField = allowed.includes(traffic_field) ? traffic_field : 'utm_source';
    const { where, params } = parseDateFilter(start_date, end_date);

    const rows = db.prepare(`
      SELECT DISTINCT COALESCE(${safeField}, 'direto') as val
      FROM analytics_events
      WHERE video_id = ? AND ${where}
    `).all(player_id, ...params);

    const out = rows.map(r => {
      const metrics = calculateSessionMetrics(player_id, start_date, end_date, video_duration, pitch_time);
      return { grouped_field: r.val, ...metrics };
    });

    res.json(out);
  });

  router.post('/traffic_origin/stats_by_day', (req, res) => {
    const { player_id, traffic_field = 'utm_source', start_date, end_date } = req.body;
    if (!player_id) return res.status(400).json({ error: 'player_id is required' });

    const allowed = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'domain'];
    const safeField = allowed.includes(traffic_field) ? traffic_field : 'utm_source';
    const { where, params } = parseDateFilter(start_date, end_date);

    const rows = db.prepare(`
      SELECT
        strftime('%Y-%m-%d', created_at) as date_key,
        COALESCE(${safeField}, 'direto') as grouped_field,
        COUNT(*) as total_events,
        COUNT(DISTINCT session_id) as total_sessions
      FROM analytics_events
      WHERE video_id = ? AND ${where}
      GROUP BY date_key, grouped_field
      ORDER BY date_key ASC
    `).all(player_id, ...params);

    res.json(rows);
  });

  router.post('/traffic_origin/valid_utms', (req, res) => {
    const { player_id, start_date, end_date } = req.body;
    const { where, params } = parseDateFilter(start_date, end_date);
    const targetSql = player_id ? 'video_id = ?' : getUserVideoFilter(req.apiUser).sql;
    const qParams = player_id ? [player_id] : getUserVideoFilter(req.apiUser).params;

    const utmFields = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
    const out = {};

    for (const field of utmFields) {
      const rows = db.prepare(`
        SELECT DISTINCT ${field} as v
        FROM analytics_events
        WHERE ${targetSql} AND ${field} IS NOT NULL AND ${field} != '' AND ${where}
      `).all(...qParams, ...params);
      out[field] = rows.map(r => r.v);
    }

    res.json(out);
  });

  function getPlayersList(req, res) {
    const { start_date, end_date, name, name_match = 'contains' } = req.query;
    let sql = 'SELECT id, title as name, duration, settings, created_at FROM videos WHERE user_id = ?';
    const params = [req.apiUser.id];

    if (start_date) {
      sql += ' AND created_at >= ?';
      params.push(start_date.replace('T', ' ').slice(0, 19));
    }
    if (end_date) {
      sql += ' AND created_at <= ?';
      params.push(end_date.replace('T', ' ').slice(0, 19));
    }
    if (name) {
      const trimmed = name.trim();
      if (name_match === 'starts_with') {
        sql += ' AND title LIKE ?';
        params.push(`${trimmed}%`);
      } else if (name_match === 'ends_with') {
        sql += ' AND title LIKE ?';
        params.push(`%${trimmed}`);
      } else if (name_match === 'exact') {
        sql += ' AND LOWER(title) = LOWER(?)';
        params.push(trimmed);
      } else {
        sql += ' AND title LIKE ?';
        params.push(`%${trimmed}%`);
      }
    }

    sql += ' ORDER BY created_at DESC';
    const rows = db.prepare(sql).all(...params);

    const out = rows.map(r => {
      let pitchTime = 0;
      try {
        const s = JSON.parse(r.settings || '{}');
        pitchTime = parseInt(s.ctaTime, 10) || 0;
      } catch (e) {}
      return {
        id: r.id,
        name: r.name || 'Sem título',
        pitch_time: pitchTime,
        duration: Math.round(r.duration || 0),
        created_at: r.created_at ? new Date(r.created_at).toISOString() : null
      };
    });

    res.json(out);
  }

  router.get('/players/list', getPlayersList);
  router.get('/players', getPlayersList);

  function getCustomMetricsHandler(req, res) {
    const playerId = req.body.player_id || req.params.player_id;
    if (!playerId) return res.status(400).json({ error: 'player_id is required' });

    const { start_date, end_date } = req.body;
    const { where, params } = parseDateFilter(start_date, end_date);

    const metrics = db.prepare('SELECT * FROM custom_metrics WHERE player_id = ? ORDER BY sequential_number ASC').all(playerId);
    const totalUsers = db.prepare(`SELECT COUNT(DISTINCT session_id) as c FROM analytics_events WHERE video_id = ? AND (event_type = 'play' OR watch_time > 0) AND ${where}`).get(playerId, ...params).c || 1;

    const out = metrics.map(m => {
      const usersAbove = db.prepare(`SELECT COUNT(DISTINCT session_id) as c FROM analytics_events WHERE video_id = ? AND watch_time >= ? AND ${where}`).get(playerId, m.time, ...params).c || 0;
      const rate = totalUsers > 0 ? Number(((usersAbove / totalUsers) * 100).toFixed(2)) : 0;
      return {
        id: m.id,
        name: m.name,
        time: m.time,
        sequential_number: m.sequential_number,
        engagement_rate: rate,
        total_users: totalUsers,
        users_above: usersAbove
      };
    });

    res.json(out);
  }

  router.post('/custom_metrics/list', getCustomMetricsHandler);
  router.get('/custom_metrics/:player_id/list', getCustomMetricsHandler);

  router.post('/comparison_groups/list', (req, res) => {
    const { start_date, end_date } = req.body;
    const { where, params } = parseDateFilter(start_date, end_date);

    const groups = db.prepare(`
      SELECT * FROM comparison_groups
      WHERE user_id = ? AND ${where}
      ORDER BY created_at DESC
    `).all(req.apiUser.id, ...params);

    const out = groups.map(g => {
      const playerRows = db.prepare('SELECT * FROM comparison_group_players WHERE comparison_group_id = ?').all(g.id);
      return {
        id: g.id,
        name: g.name,
        player_ids: playerRows.map(p => p.player_id),
        players: playerRows.map(p => ({
          player_id: p.player_id,
          traffic_percentage: p.traffic_percentage,
          started_at: p.started_at ? new Date(p.started_at).toISOString() : null,
          locked: !!p.locked
        })),
        started_at: g.started_at ? new Date(g.started_at).toISOString() : null,
        finished_at: g.finished_at ? new Date(g.finished_at).toISOString() : null,
        created_at: g.created_at ? new Date(g.created_at).toISOString() : null
      };
    });

    res.json(out);
  });

  router.post('/comparison_groups/stats', (req, res) => {
    const { comparison_group_id, items } = req.body;
    if (!comparison_group_id) return res.status(400).json({ error: 'comparison_group_id is required' });

    const group = db.prepare('SELECT * FROM comparison_groups WHERE id = ? AND user_id = ?').get(comparison_group_id, req.apiUser.id);
    if (!group) return res.status(404).json({ error: 'Comparison group not found' });

    const enrolledPlayers = db.prepare('SELECT * FROM comparison_group_players WHERE comparison_group_id = ?').all(group.id);
    const validPlayerIds = enrolledPlayers.map(p => p.player_id);

    const targetItems = (Array.isArray(items) ? items : []).filter(i => validPlayerIds.includes(i.player_id)).slice(0, 2);
    if (!targetItems.length) {
      return res.status(422).json({ error: 'No requested players belong to this comparison group' });
    }

    const stats = targetItems.map(item => {
      const vid = db.prepare('SELECT * FROM videos WHERE id = ?').get(item.player_id);
      const enrolled = enrolledPlayers.find(p => p.player_id === item.player_id);
      const startDate = item.start_date || (enrolled && enrolled.started_at) || group.started_at;
      const duration = vid ? Math.round(vid.duration || 0) : 3600;
      let pitchTime = 0;
      try {
        const s = JSON.parse(vid.settings || '{}');
        pitchTime = parseInt(s.ctaTime, 10) || 0;
      } catch (e) {}

      const metrics = calculateSessionMetrics(item.player_id, startDate, item.end_date, duration, pitchTime);
      const visits = metrics.total_viewed || 1;
      const rpvUsd = Number(((metrics.total_amount_usd || 0) / visits).toFixed(4));
      const rpvBrl = Number(((metrics.total_amount_brl || 0) / visits).toFixed(4));
      const rpvEur = Number(((metrics.total_amount_eur || 0) / visits).toFixed(4));

      return {
        player_id: item.player_id,
        pitch_time: pitchTime,
        video_duration: duration,
        views: {
          total: metrics.total_viewed,
          total_uniq_sessions: metrics.total_viewed_session_uniq,
          total_uniq_device: metrics.total_viewed_device_uniq
        },
        plays: {
          total: metrics.total_started,
          total_uniq_sessions: metrics.total_started_session_uniq,
          total_uniq_device: metrics.total_started_device_uniq
        },
        finishes: {
          total: metrics.total_finished,
          total_uniq_sessions: metrics.total_finished_session_uniq,
          total_uniq_device: metrics.total_finished_device_uniq
        },
        clicks: {
          total: metrics.total_clicked,
          total_uniq_sessions: metrics.total_clicked_session_uniq,
          total_uniq_device: metrics.total_clicked_device_uniq
        },
        conversions: {
          total: metrics.total_conversions,
          total_uniq_sessions: metrics.total_conversions,
          total_uniq_device: metrics.total_conversions,
          total_amount_usd: metrics.total_amount_usd,
          total_amount_brl: metrics.total_amount_brl,
          total_amount_eur: metrics.total_amount_eur
        },
        engagement: {
          average_watched_time: Number(((metrics.engagement_rate / 100) * duration).toFixed(1)),
          engagement_rate: metrics.engagement_rate,
          grouped_timed: [
            { timed: 0, total_users: metrics.total_started },
            { timed: Math.round(duration / 2), total_users: Math.round(metrics.total_started * 0.5) }
          ]
        },
        pitch_audience: metrics.total_over_pitch,
        pitch_retention_rate: metrics.over_pitch_rate,
        play_rate: metrics.play_rate,
        conversion_rate: metrics.overall_conversion_rate,
        rpv_usd: rpvUsd,
        rpv_brl: rpvBrl,
        rpv_eur: rpvEur
      };
    });

    res.json({
      comparison_group: {
        id: group.id,
        name: group.name,
        player_ids: validPlayerIds,
        started_at: group.started_at ? new Date(group.started_at).toISOString() : null,
        finished_at: group.finished_at ? new Date(group.finished_at).toISOString() : null
      },
      stats: stats
    });
  });

  router.get('/quota/usage', (req, res) => {
    const keyId = req.apiKey.id;
    const now = new Date();
    const minStart = new Date(Math.floor(now.getTime() / 60000) * 60000);
    const minEnd = new Date(minStart.getTime() + 60000);
    const dayStart = new Date(now.toISOString().slice(0, 10) + 'T00:00:00Z');
    const dayEnd = new Date(dayStart.getTime() + 86400000);

    const minRow = db.prepare('SELECT COUNT(*) as q, SUM(read_bytes) as b FROM api_quota_logs WHERE api_key_id = ? AND timestamp >= ?').get(keyId, minStart.toISOString());
    const dayRow = db.prepare('SELECT COUNT(*) as q, SUM(read_bytes) as b FROM api_quota_logs WHERE api_key_id = ? AND timestamp >= ?').get(keyId, dayStart.toISOString());

    const limitPerMin = req.apiUser.quota_limit || 60;
    const usedMin = minRow.q || 0;
    const usedDay = dayRow.q || 0;

    res.json({
      quotas: [
        {
          interval_seconds: 60,
          interval_starts_at: minStart.toISOString(),
          interval_ends_at: minEnd.toISOString(),
          queries: {
            used: usedMin,
            limit: limitPerMin,
            remaining: Math.max(0, limitPerMin - usedMin),
            note: 'a single API request may count as more than one query against this limit'
          },
          read_bytes: {
            used: minRow.b || 1024,
            limit: null,
            remaining: null
          }
        },
        {
          interval_seconds: 86400,
          interval_starts_at: dayStart.toISOString(),
          interval_ends_at: dayEnd.toISOString(),
          queries: {
            used: usedDay,
            limit: null,
            remaining: null
          },
          read_bytes: {
            used: dayRow.b || 20480,
            limit: 343597383680,
            remaining: Math.max(0, 343597383680 - (dayRow.b || 20480))
          }
        }
      ]
    });
  });

  return router;
};
