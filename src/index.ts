import { redisClient } from "./config/redis";

const STREAM_KEY = process.env.BULK_STREAM_KEY!;
const GROUP_NAME = process.env.BULK_CONSUMER_GROUP!;

const MIN_IDLE_TIME_MS = Number(process.env.MIN_IDLE_TIME_MS! || 60_000);
const BATCH_SIZE = Number(process.env.BATCH_SIZE! || 50);
const MAX_RETRIES = Number(process.env.MAX_RETRIES! || 3);
const SLEEP_INTERVAL_MS = Number(process.env.SLEEP_INTERVAL_MS! || 15_000);

let isRunning = true;
let cursor = '0-0';

const JANITOR_CONSUMER = `janitor-${Bun.randomUUIDv7()}`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function startAutoClaimWorker() {
    await redisClient.connect();
    console.log(`[Janitor] Started recovery worker: ${JANITOR_CONSUMER}`);

    while (isRunning) {
        let nextSleep = SLEEP_INTERVAL_MS;

        try {
            const response = await redisClient.xAutoClaim(
                STREAM_KEY,
                GROUP_NAME,
                JANITOR_CONSUMER,
                MIN_IDLE_TIME_MS,
                cursor,
                { COUNT: BATCH_SIZE }
            );

            cursor = response.nextId;
            const { messages, deletedMessages } = response;

            if (deletedMessages && deletedMessages.length > 0) {
                await redisClient.xAck(STREAM_KEY, GROUP_NAME, deletedMessages);
            }

            if (messages && messages.length > 0) {
                const toAckAndDel: string[] = [];

                for (const message of messages) {
                    if (!message) continue;
                    const { id, message: fields } = message;

                    console.log(`got message : ${JSON.stringify(fields)}`);


                    const retries = Number(fields.retry_count || 1);

                    if (retries >= MAX_RETRIES) {

                        toAckAndDel.push(id);
                    } else {
                        await redisClient.xAdd(STREAM_KEY, '*', {
                            ...fields,
                            retry_count: String(retries + 1)
                        });

                        toAckAndDel.push(id);
                    }
                }

                if (toAckAndDel.length > 0) {
                    await redisClient.xAck(STREAM_KEY, GROUP_NAME, toAckAndDel);
                    await redisClient.xDel(STREAM_KEY, toAckAndDel);
                }

                if (cursor !== '0-0') {
                    nextSleep = 100;
                }
            } else {
                cursor = '0-0';
            }
        } catch (err) {
            console.error('[Janitor Error] Exception during autoclaim loop:', err);
            nextSleep = 5_000;
        }

        if (isRunning) {
            await sleep(nextSleep);
        }
    }

    await redisClient.quit();
}

const handleShutdown = () => {
    isRunning = false;
};

process.on('SIGTERM', handleShutdown);
process.on('SIGINT', handleShutdown);

startAutoClaimWorker().catch((err) => {
    console.log("Fatal Error, auto claim worker died : ", err);
    process.exit(1);
});