import { createClient } from 'redis';

export const redisClient = createClient({
    url: process.env.REDIS_URL!,
    socket: {
        reconnectStrategy: retries => {
            if (retries > 5) return new Error('Too many retries');
            return Math.min(retries * 50, 500);
        }
    }
});

redisClient.on('error', (err) => {
    console.error('Redis Subscriber Error : ', err);
});

redisClient.on('connect', () => console.log('Redis Subscriber connected'));