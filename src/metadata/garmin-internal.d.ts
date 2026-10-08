declare module "@garmin/fitsdk/src/utils-hr-mesg.js" {
  interface HrMessage {
    timestamp?: number;
    fractionalTimestamp?: number;
    filteredBpm: number[];
    eventTimestamp: number[];
  }
  interface HrSample {
    timestamp: number;
    heartRate: number;
  }
  const utility: { expandHeartRates(messages: HrMessage[]): HrSample[] };
  export default utility;
}
