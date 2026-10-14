import {useEffect,useState} from 'react';
import {api} from '../api';
import {formatError} from '../controls';
import {ModelPanel} from './ModelPanel';

export function ModelSettingsPage({refreshVersion}:{refreshVersion:number}) {
  const selectedContact=()=>location.hash.startsWith('#models/')?decodeURIComponent(location.hash.slice(8)):'';
  const [contactId,setContactId]=useState(selectedContact);
  const [candidateOnly,setCandidateOnly]=useState<boolean>(),[error,setError]=useState('');
  useEffect(()=>{const changed=()=>setContactId(selectedContact());addEventListener('hashchange',changed);return()=>removeEventListener('hashchange',changed);},[]);
  useEffect(()=>{
    const controller=new AbortController();setError('');setCandidateOnly(undefined);
    void api.workspaceList(new URLSearchParams({limit:'1'}),controller.signal)
      .then(result=>setCandidateOnly(result.candidateOnly===true))
      .catch(e=>{if(!controller.signal.aborted)setError(formatError(e));});
    return()=>controller.abort();
  },[refreshVersion]);
  return <article className="card model-settings-page">
    <p className="muted">在这里选择模型、填写接口和密钥，保存后启用。</p>
    {error?<p role="alert" className="error">{error}</p>:candidateOnly===undefined?<p role="status">正在读取模型配置…</p>:<ModelPanel contactId={contactId} readOnly={candidateOnly}/>}
  </article>;
}
