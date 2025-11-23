import { deleteClicksBefore, getRecentClicks } from "@/helpers/durable-queries";
import { DurableObject } from "cloudflare:workers";
import moment from "moment";

export class LinkClickTracker extends DurableObject<Env> {
    sql: SqlStorage;
    oldestOffsetTime: number = 0;
    mostRecentOffsetTime: number = 0;

    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env);
        this.sql = ctx.storage.sql;

        
        // If we spin up a DO, and another function somewhere else in our code
        // spins up the same DO, it might try to fetch data before the table exists.
        ctx.blockConcurrencyWhile(async () => {
            const [oldestOffsetTime, mostRecentOffsetTime] = await Promise.all([
                ctx.storage.get<number>('oldestOffsetTime'),
                ctx.storage.get<number>('mostRecentOffsetTime'),
            ]);

            this.oldestOffsetTime = oldestOffsetTime ?? this.oldestOffsetTime;
            this.mostRecentOffsetTime = mostRecentOffsetTime ?? this.mostRecentOffsetTime;

            this.sql.exec(`
                CREATE TABLE IF NOT EXISTS geo_link_clicks (
                    latitude REAL NOT NULL,
                    longitude REAL NOT NULL,
                    country TEXT NOT NULL,
                    time INTEGER NOT NULL
                )    
            `)
        })
    }

    async addClick(latitude: number, longitude: number, country: string, time: number) {
        this.sql.exec(
            `
            INSERT INTO geo_link_clicks (latitude, longitude, country, time)
            VALUES (?, ?, ?, ?)
            `,
            latitude,
            longitude,
            country,
            time
        )

        const alarm = await this.ctx.storage.getAlarm();
        if (!alarm) await this.ctx.storage.setAlarm(moment().add(2, "seconds").valueOf())
    }

    async alarm(alarmInfo?: AlarmInvocationInfo) {
        console.log('alarm');
        const clickData = getRecentClicks(this.sql, this.mostRecentOffsetTime);

        const sockets = this.ctx.getWebSockets();
        // Data will cascade to all websocket clients
        for (const socket of sockets) {
            socket.send(JSON.stringify(clickData.clicks));
        }

        await this.flushOffsetTimes(clickData.mostRecentTime, clickData.oldestTime);
        await deleteClicksBefore(this.sql, clickData.oldestTime);
    }

    async flushOffsetTimes(mostRecentOffsetTime: number, oldestOffsetTime: number) {
        this.mostRecentOffsetTime = mostRecentOffsetTime;
        this.oldestOffsetTime = oldestOffsetTime
        this.ctx.storage.put<number>('mostRecentOffsetTime', mostRecentOffsetTime);
        this.ctx.storage.put<number>('oldestOffsetTime', oldestOffsetTime);
    }

    async fetch(_: Request) {
        const webSocketPair = new WebSocketPair();
        const [client, server] = Object.values(webSocketPair);
        this.ctx.acceptWebSocket(server);
        return new Response(null, {
            status: 101,
            webSocket: client
        })
    }

    webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): void | Promise<void> {
        console.log("Client closed");
    }
}