import express from 'express';
import { startAutoClaimWorker } from '.';
const app = express();

app.get('/health', (_req, res) => {
    res.send('Healthy');
})

async function main() {
    startAutoClaimWorker();

    app.listen(process.env.PORT, () => console.log(`Bulk DB updater started running on port : ${process.env.PORT}`));
}

main();