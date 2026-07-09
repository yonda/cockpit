// Google Calendar API クライアント (OAuth refresh token 方式)。
// 認証のセットアップは bin/google-auth を参照。

export type CalendarEvent = {
  id: string;
  title: string;
  start: string; // ISO
  end: string; // ISO
  allDay: boolean;
  meetUrl: string | null;
  location: string | null;
  declined: boolean;
};

export type TodaySchedule = {
  events: CalendarEvent[];
  fetchedAt: string;
};

function googleEnv(): {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
} | null {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) return null;
  return { clientId, clientSecret, refreshToken };
}

export function isCalendarConfigured(): boolean {
  return googleEnv() !== null;
}

// access token は ~1h 有効。余裕をみて 50 分キャッシュ
let cachedToken: { token: string; expiresAt: number } | null = null;

async function accessToken(): Promise<string> {
  const env = googleEnv();
  if (!env) throw new Error("Google Calendar の環境変数が未設定です");

  if (cachedToken && Date.now() < cachedToken.expiresAt) {
    return cachedToken.token;
  }

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.clientId,
      client_secret: env.clientSecret,
      refresh_token: env.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Google token refresh failed (${res.status}): ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + Math.min(data.expires_in - 600, 3000) * 1000,
  };
  return data.access_token;
}

type GoogleEventItem = {
  id: string;
  status?: string;
  summary?: string;
  location?: string;
  hangoutLink?: string;
  start?: { date?: string; dateTime?: string };
  end?: { date?: string; dateTime?: string };
  attendees?: Array<{ self?: boolean; responseStatus?: string }>;
  conferenceData?: {
    entryPoints?: Array<{ entryPointType?: string; uri?: string }>;
  };
};

function meetUrl(item: GoogleEventItem): string | null {
  if (item.hangoutLink) return item.hangoutLink;
  const video = item.conferenceData?.entryPoints?.find(
    (e) => e.entryPointType === "video" && e.uri,
  );
  return video?.uri ?? null;
}

// 今日 (ローカルタイムゾーン) の予定。繰り返しは singleEvents=true で API 側が展開する
export async function fetchTodaySchedule(): Promise<TodaySchedule> {
  const token = await accessToken();

  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setDate(dayEnd.getDate() + 1);

  const params = new URLSearchParams({
    timeMin: dayStart.toISOString(),
    timeMax: dayEnd.toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "50",
  });
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
    { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" },
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Calendar API failed (${res.status}): ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as { items?: GoogleEventItem[] };

  const events: CalendarEvent[] = (data.items ?? [])
    .filter((item) => item.status !== "cancelled")
    .map((item) => {
      const allDay = Boolean(item.start?.date);
      const self = item.attendees?.find((a) => a.self);
      return {
        id: item.id,
        title: item.summary ?? "(no title)",
        start: item.start?.dateTime ?? item.start?.date ?? "",
        end: item.end?.dateTime ?? item.end?.date ?? "",
        allDay,
        meetUrl: meetUrl(item),
        location: item.location ?? null,
        declined: self?.responseStatus === "declined",
      };
    })
    .filter((e) => e.start && !e.declined);

  return { events, fetchedAt: new Date().toISOString() };
}
