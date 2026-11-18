import { Connection, Client } from '@temporalio/client';
import { TASK_QUEUE } from './shared';

// プロジェクトに依らないスケジュールを Temporal Schedule に登録する。
//   outer-loop-daily  Outer Loop (毎日 03:00)
//   chief-patrol      巡回 (9〜21 時の毎時 0 分)。期限を過ぎた仕事の段階を上げ、判断待ちをチーフに渡す
// 使い方: docker compose exec worker npm run schedule (何度実行してもよい)
//         docker compose exec worker npm run schedule -- chief-patrol (巡回だけを登録する)
const SCHEDULES = [
  {
    scheduleId: 'outer-loop-daily',
    cron: '0 3 * * *',
    workflowType: 'outerLoopWorkflow',
    workflowId: 'outer-loop',
    label: '毎日 03:00 Asia/Tokyo',
  },
  {
    scheduleId: 'chief-patrol',
    cron: '0 9-21 * * *',
    workflowType: 'patrolWorkflow',
    workflowId: 'chief-patrol',
    label: '9〜21 時の毎時 0 分 Asia/Tokyo',
  },
];

async function main(): Promise<void> {
  const connection = await Connection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
  });
  const client = new Client({ connection });
  // 引数で ID を渡すと、そのスケジュールだけを登録する (例: npm run schedule -- chief-patrol)
  const only = process.argv.slice(2);
  const unknown = only.filter((id) => !SCHEDULES.some((s) => s.scheduleId === id));
  if (unknown.length) throw new Error(`unknown schedule: ${unknown.join(', ')}`);
  for (const s of SCHEDULES.filter((x) => !only.length || only.includes(x.scheduleId))) {
    try {
      await client.schedule.create({
        scheduleId: s.scheduleId,
        spec: { cronExpressions: [s.cron], timezone: 'Asia/Tokyo' },
        action: {
          type: 'startWorkflow',
          workflowType: s.workflowType,
          taskQueue: TASK_QUEUE,
          workflowId: s.workflowId,
        },
      });
      console.log(`registered schedule: ${s.scheduleId} (${s.label})`);
    } catch (err: any) {
      if (err?.name === 'ScheduleAlreadyRunning') {
        console.log(`schedule already registered: ${s.scheduleId}`);
      } else {
        throw err;
      }
    }
  }
  await connection.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
