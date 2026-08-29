import express from 'express';
import { startWorker } from '.';

const app = express();

async function main() {
    startWorker();

    app.listen(process.env.PORT, () => console.log(`Bulk DB updater started running on port : ${process.env.PORT}`));
}

main();