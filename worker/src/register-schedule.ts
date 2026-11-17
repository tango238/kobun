import { Connection, Client } from '@temporalio/client';
import { TASK_QUEUE } from './shared';

// Outer Loop の日次スケジュールを Temporal Schedule に登録する。
// 使い方: docker compose exec worker npm run schedule
async function main(): Promise<void> {
  const connection = await Connection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
  });
  const client = new Client({ connection });
  try {
    await client.schedule.create({
      scheduleId: 'outer-loop-daily',
      spec: {
        cronExpressions: ['0 3 * * *'],
        timeZone: 'Asia/Tokyo',
      },
      action: {
        type: 'startWorkflow',
        workflowType: 'outerLoopWorkflow',
        taskQueue: TASK_QUEUE,
        workflowId: 'outer-loop',
      },
    });
    console.log('registered schedule: outer-loop-daily (毎日 03:00 Asia/Tokyo)');
  } catch (err: any) {
    if (err?.name === 'ScheduleAlreadyRunning') {
      console.log('schedule already registered: outer-loop-daily');
    } else {
      throw err;
    }
  }
  await connection.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
