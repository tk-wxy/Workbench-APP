/**
 * 串行执行共享持久化资源上的写任务，并为每个业务域提供 latest-wins 水位。
 *
 * 队列解决“两个任务同时改同一个整文件”的问题；isLatest 解决旧任务在 await 后恢复、
 * 反而把新状态覆盖回去的问题。任务在任何 await 之后、真正写入前都应再检查 isLatest()。
 */
export class LatestWriteQueue<Domain extends string> {
  private tail: Promise<void> = Promise.resolve();
  private revisions = new Map<Domain, number>();

  enqueue(domain: Domain, task: (isLatest: () => boolean) => Promise<void>): Promise<void> {
    const revision = (this.revisions.get(domain) ?? 0) + 1;
    this.revisions.set(domain, revision);
    const isLatest = () => this.revisions.get(domain) === revision;
    const runTask = () => isLatest() ? task(isLatest) : Promise.resolve();

    const run = this.tail.then(runTask, runTask);
    // 队尾永远恢复为 fulfilled，单次失败不能毒死后续任务；具体任务负责记录带域名的错误。
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }
}
