// 原生视频：复用公开 B 站解析/字幕逻辑；不接旧 DSH token，也不声称看过没有的画面。
import {BiliVideoService} from './video.js';
const media=async()=>{throw new Error('本机未接入关键帧裁切，只返回标题/简介/公开字幕');};
const video=new BiliVideoService({media});
export async function runVideo(args={}){
  const action=args.action??'browse';
  if(action==='browse')return video.browse(args.keyword??'');
  if(action==='watch')return video.watch(args.url??args.bvid??'');
  if(action==='zoom')return video.zoom(args.url??args.bvid??'',Number(args.fromSeconds),Number(args.toSeconds));
  throw new Error('未知视频动作');
}