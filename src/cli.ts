import { validateLab } from './lab-validation.ts';
import { exportBundle, restyleBundle } from './support-bundle.ts';
import { verifyAnyBundle } from './bundle-dispatch.ts';
import { inspectPoolingReview, formatPoolingReview, poolingReviewTemplate, appendPoolingReview } from './pooling-review.ts';
import { validatePooling } from './pooling-validation.ts';
import { exportPoolingBundle } from './pooling-bundle.ts';
import { inspectLabReview, labReviewMarkdown, reviewTemplate, appendLabReview } from './lab-review.ts';
import { readFileSync } from 'node:fs';
import { gaps, markdown } from './gaps.ts';
import { parseIntake } from './intake.ts';
import { investigationGaps, investigationMarkdown } from './investigation-gaps.ts';
import { createCase, appendObservation, inspectLedger, readJson, LedgerError } from './ledger.ts';
const args=process.argv.slice(2);
const usage='Usage: gaps|intake INPUT.json [--json] [--dry-run]; ledger init DIR CASE.json; ledger append DIR OBSERVATION.json; ledger inspect DIR [HEAD_HASH]; ledger gaps DIR [--json]. Ledger commands accept --dry-run.';
try {
  if (args[0] === 'guide') {
    if (args.length === 2 && args[1] === '--dry-run') console.log(JSON.stringify({operation:'guide',network:false,database:false,writes:false,readsInput:false,interactive:true}));
    else if (args.length === 1) await (await import('./terminal.ts')).guidedTerminal();
    else throw new LedgerError('Usage: guide [--dry-run]. Execution choices require interactive confirmation.');
  } else if(args[0]==='profile') {
    if(!(args[1]==='check-sources' && args.length===3 && !args[2].startsWith('--'))) throw new LedgerError('Usage: profile check-sources DIR. DIR holds freshly downloaded copies of each source, saved as <source id>.md.');
    const { loadProfile, checkProfileSources } = await import('./platform-profile.ts');
    const result=checkProfileSources(loadProfile(),args[2]);
    console.log(JSON.stringify(result,null,2)); if(result.sourceReviewRequired) process.exitCode=1;
  } else if(args[0]==='lab' && args[1]==='packs') {
    const extra=args.slice(2);
    if(extra.length>1 || extra.length===1 && !['--json','--check'].includes(extra[0])) throw new LedgerError('Usage: lab packs [--json|--check]');
    const { loadPacks, formatPacks } = await import('./lab-packs.ts');
    const packs=loadPacks();
    console.log(extra[0]==='--json'?JSON.stringify(packs,null,2):extra[0]==='--check'?`All ${packs.length} lab pack files are valid.`:formatPacks(packs));
  } else if(args[0]==='lab' && ['validate','export','verify-bundle','restyle-bundle'].includes(args[1])) {
    const dry=args.at(-1)==='--dry-run', parts=dry?args.slice(0,-1):args;
    const [,action,dir,target,flag]=parts;
    const valid=action==='restyle-bundle'?Boolean(target)&&[4,5].includes(parts.length)&&(flag===undefined||/^[a-f0-9]{64}$/.test(flag)):action==='validate'?parts.length===3:action==='export'
      ? Boolean(target)&&([4,5].includes(parts.length))&&(flag===undefined||flag==='--gaps-only')
      : [3,4].includes(parts.length)&&(target===undefined||/^[a-f0-9]{64}$/.test(target));
    if(!dir||!valid) throw new LedgerError('Usage: lab validate DIR; lab export DIR NEW_OUTPUT [--gaps-only]; lab verify-bundle DIR [MANIFEST_HASH]; lab restyle-bundle DIR NEW_OUTPUT [MANIFEST_HASH]. Commands accept --dry-run.');
    if(dry) console.log(JSON.stringify({operation:'lab '+action,network:false,database:false,writes:false,wouldWrite:action==='export'||action==='restyle-bundle',readsInput:false}));
    else {
      try { console.log(JSON.stringify(action==='restyle-bundle'?restyleBundle(dir,target,{expectedManifestHash:flag}):action==='validate'?validateLab(dir):action==='export'?exportBundle(dir,target,{mode:flag==='--gaps-only'?'gaps':'reviewed'}):verifyAnyBundle(dir,{expectedManifestHash:target}),null,2)); }
      catch(error) { if(error instanceof LedgerError) throw error; throw new LedgerError('Bundle operation failed. Check paths, permissions and whether the output directory already exists.'); }
    }
  } else if(args[0]==='pooling') {
    const [, action, dir, ...tail] = args;
    const dry = tail.includes('--dry-run'), parts = tail.filter(v => v !== '--dry-run');
    const valid = action === 'compare' || action === 'profile-check' ? parts.length === 0 || parts.length === 1 && parts[0] === '--json'
      : action === 'review-template' ? parts.length === 1 && ['cause','remedy'].includes(parts[0])
      : action === 'review' ? parts.length === 1 && !parts[0].startsWith('--')
      : action === 'validate' ? parts.length === 0
      : action === 'export' && (parts.length === 1 && !parts[0].startsWith('--') || parts.length === 2 && parts[1] === '--gaps-only');
    if (!dir || !valid || tail.filter(v => v === '--dry-run').length > 1) throw new LedgerError('Usage: pooling compare DIR [--json]; pooling review-template DIR cause|remedy; pooling review DIR INPUT.json; pooling validate DIR; pooling export DIR NEW_OUTPUT [--gaps-only]; pooling profile-check DIR [--json]. Commands accept --dry-run.');
    if (dry) console.log(JSON.stringify({operation:'pooling '+action,network:false,database:false,writes:false,wouldWrite:['review','export'].includes(action),readsInput:false}));
    else {
      try {
        if (action === 'profile-check') { const { poolingProfileCheck, formatProfileCheck } = await import('./pooling-profile-check.ts'); const c = poolingProfileCheck(dir); console.log(parts.includes('--json') ? JSON.stringify(c,null,2) : formatProfileCheck(c)); }
        else if (action === 'compare') console.log(parts.includes('--json') ? JSON.stringify(inspectPoolingReview(dir),null,2) : formatPoolingReview(inspectPoolingReview(dir)));
        else console.log(JSON.stringify(action === 'review-template' ? poolingReviewTemplate(dir, parts[0] as 'cause'|'remedy') : action === 'review' ? appendPoolingReview(dir,readJson(parts[0]))
          : action === 'validate' ? validatePooling(dir) : exportPoolingBundle(dir, parts[0], {mode: parts[1] === '--gaps-only' ? 'gaps' : 'reviewed'}),null,2));
      } catch(error) { if(error instanceof LedgerError) throw error; throw new LedgerError('Pooling operation failed. Check the artifact paths, file permissions and whether the output directory already exists.'); }
    }
  } else if(args[0]==='index') {
    const [, action, dir, ...tail] = args;
    const dry = tail.includes('--dry-run'), parts = tail.filter(v => v !== '--dry-run');
    const valid = action === 'compare' ? parts.length === 0 || parts.length === 1 && parts[0] === '--json'
      : action === 'review-template' ? parts.length === 1 && ['cause','remedy'].includes(parts[0])
      : action === 'review' ? parts.length === 1 && !parts[0].startsWith('--')
      : action === 'validate' ? parts.length === 0
      : action === 'export' && (parts.length === 1 && !parts[0].startsWith('--') || parts.length === 2 && parts[1] === '--gaps-only');
    if (!dir || !valid || tail.filter(v => v === '--dry-run').length > 1) throw new LedgerError('Usage: index compare DIR [--json]; index review-template DIR cause|remedy; index review DIR INPUT.json; index validate DIR; index export DIR NEW_OUTPUT [--gaps-only]. Commands accept --dry-run.');
    if (dry) console.log(JSON.stringify({operation:'index '+action,network:false,database:false,writes:false,wouldWrite:['review','export'].includes(action),readsInput:false}));
    else {
      try {
        const review = await import('./index-review.ts');
        if (action === 'compare') console.log(parts.includes('--json') ? JSON.stringify(review.inspectIndexReview(dir),null,2) : review.formatIndexReview(review.inspectIndexReview(dir)));
        else console.log(JSON.stringify(action === 'review-template' ? review.indexReviewTemplate(dir, parts[0] as 'cause'|'remedy') : action === 'review' ? review.appendIndexReview(dir,readJson(parts[0]))
          : action === 'validate' ? (await import('./index-validation.ts')).validateIndex(dir) : (await import('./index-bundle.ts')).exportIndexBundle(dir, parts[0], {mode: parts[1] === '--gaps-only' ? 'gaps' : 'reviewed'}),null,2));
      } catch(error) { if(error instanceof LedgerError) throw error; throw new LedgerError('Index operation failed. Check the artifact paths, file permissions and whether the output directory already exists.'); }
    }
  } else if(args[0]==='connectivity') {
    const [, action, dir, ...tail] = args;
    const dry = tail.includes('--dry-run'), parts = tail.filter(v => v !== '--dry-run');
    const valid = action === 'compare' ? parts.length === 0 || parts.length === 1 && parts[0] === '--json'
      : action === 'review-template' ? parts.length === 1 && ['cause','remedy'].includes(parts[0])
      : action === 'review' ? parts.length === 1 && !parts[0].startsWith('--')
      : action === 'validate' ? parts.length === 0
      : action === 'export' && (parts.length === 1 && !parts[0].startsWith('--') || parts.length === 2 && parts[1] === '--gaps-only');
    if (!dir || !valid || tail.filter(v => v === '--dry-run').length > 1) throw new LedgerError('Usage: connectivity compare DIR [--json]; connectivity review-template DIR cause|remedy; connectivity review DIR INPUT.json; connectivity validate DIR; connectivity export DIR NEW_OUTPUT [--gaps-only]. Commands accept --dry-run.');
    if (dry) console.log(JSON.stringify({operation:'connectivity '+action,network:false,database:false,writes:false,wouldWrite:['review','export'].includes(action),readsInput:false}));
    else {
      try {
        const review = await import('./connectivity-review.ts');
        if (action === 'compare') console.log(parts.includes('--json') ? JSON.stringify(review.inspectConnectivityReview(dir),null,2) : review.formatConnectivityReview(review.inspectConnectivityReview(dir)));
        else console.log(JSON.stringify(action === 'review-template' ? review.connectivityReviewTemplate(dir, parts[0] as 'cause'|'remedy') : action === 'review' ? review.appendConnectivityReview(dir,readJson(parts[0]))
          : action === 'validate' ? (await import('./connectivity-validation.ts')).validateConnectivity(dir) : (await import('./connectivity-bundle.ts')).exportConnectivityBundle(dir, parts[0], {mode: parts[1] === '--gaps-only' ? 'gaps' : 'reviewed'}),null,2));
      } catch(error) { if(error instanceof LedgerError) throw error; throw new LedgerError('Connectivity operation failed. Check the artifact paths, file permissions and whether the output directory already exists.'); }
    }
  } else if(args[0]==='permissions') {
    const [, action, dir, ...tail] = args;
    const dry = tail.includes('--dry-run'), parts = tail.filter(v => v !== '--dry-run');
    const valid = action === 'compare' ? parts.length === 0 || parts.length === 1 && parts[0] === '--json'
      : action === 'review-template' ? parts.length === 1 && ['cause','remedy'].includes(parts[0])
      : action === 'review' ? parts.length === 1 && !parts[0].startsWith('--')
      : action === 'validate' ? parts.length === 0
      : action === 'export' && (parts.length === 1 && !parts[0].startsWith('--') || parts.length === 2 && parts[1] === '--gaps-only');
    if (!dir || !valid || tail.filter(v => v === '--dry-run').length > 1) throw new LedgerError('Usage: permissions compare DIR [--json]; permissions review-template DIR cause|remedy; permissions review DIR INPUT.json; permissions validate DIR; permissions export DIR NEW_OUTPUT [--gaps-only]. Commands accept --dry-run.');
    if (dry) console.log(JSON.stringify({operation:'permissions '+action,network:false,database:false,writes:false,wouldWrite:['review','export'].includes(action),readsInput:false}));
    else {
      try {
        const review = await import('./permissions-review.ts');
        if (action === 'compare') console.log(parts.includes('--json') ? JSON.stringify(review.inspectPermissionsReview(dir),null,2) : review.formatPermissionsReview(review.inspectPermissionsReview(dir)));
        else console.log(JSON.stringify(action === 'review-template' ? review.permissionsReviewTemplate(dir, parts[0] as 'cause'|'remedy') : action === 'review' ? review.appendPermissionsReview(dir,readJson(parts[0]))
          : action === 'validate' ? (await import('./permissions-validation.ts')).validatePermissions(dir) : (await import('./permissions-bundle.ts')).exportPermissionsBundle(dir, parts[0], {mode: parts[1] === '--gaps-only' ? 'gaps' : 'reviewed'}),null,2));
      } catch(error) { if(error instanceof LedgerError) throw error; throw new LedgerError('Permissions operation failed. Check the artifact paths, file permissions and whether the output directory already exists.'); }
    }
  } else if(args[0]==='pool-exhaustion') {
    const [, action, dir, ...tail] = args;
    const dry = tail.includes('--dry-run'), parts = tail.filter(v => v !== '--dry-run');
    const valid = action === 'compare' ? parts.length === 0 || parts.length === 1 && parts[0] === '--json'
      : action === 'review-template' ? parts.length === 1 && ['cause','remedy'].includes(parts[0])
      : action === 'review' ? parts.length === 1 && !parts[0].startsWith('--')
      : action === 'validate' ? parts.length === 0
      : action === 'export' && (parts.length === 1 && !parts[0].startsWith('--') || parts.length === 2 && parts[1] === '--gaps-only');
    if (!dir || !valid || tail.filter(v => v === '--dry-run').length > 1) throw new LedgerError('Usage: pool-exhaustion compare DIR [--json]; pool-exhaustion review-template DIR cause|remedy; pool-exhaustion review DIR INPUT.json; pool-exhaustion validate DIR; pool-exhaustion export DIR NEW_OUTPUT [--gaps-only]. Commands accept --dry-run.');
    if (dry) console.log(JSON.stringify({operation:'pool-exhaustion '+action,network:false,database:false,writes:false,wouldWrite:['review','export'].includes(action),readsInput:false}));
    else {
      try {
        const review = await import('./pool-exhaustion-review.ts');
        if (action === 'compare') console.log(parts.includes('--json') ? JSON.stringify(review.inspectLeakReview(dir),null,2) : review.formatLeakReview(review.inspectLeakReview(dir)));
        else console.log(JSON.stringify(action === 'review-template' ? review.leakReviewTemplate(dir, parts[0] as 'cause'|'remedy') : action === 'review' ? review.appendLeakReview(dir,readJson(parts[0]))
          : action === 'validate' ? (await import('./pool-exhaustion-validation.ts')).validateLeak(dir) : (await import('./pool-exhaustion-bundle.ts')).exportLeakBundle(dir, parts[0], {mode: parts[1] === '--gaps-only' ? 'gaps' : 'reviewed'}),null,2));
      } catch(error) { if(error instanceof LedgerError) throw error; throw new LedgerError('Pool-exhaustion operation failed. Check the artifact paths, file permissions and whether the output directory already exists.'); }
    }
  } else if(args[0]==='lab') {
    const [, action, dir, ...tail] = args;
    const dry = tail.includes('--dry-run');
    const parts = tail.filter(v => v !== '--dry-run');
    const valid = action === 'compare' ? parts.length === 0 || parts.length === 1 && parts[0] === '--json'
      : action === 'review-template' ? parts.length === 0 : action === 'review' && parts.length === 1 && !parts[0].startsWith('--');
    if (!dir || !valid || tail.filter(v => v === '--dry-run').length > 1) throw new LedgerError('Usage: lab compare DIR [--json]; lab review-template DIR; lab review DIR INPUT.json. Commands accept --dry-run.');
    if (dry) console.log(JSON.stringify({operation: 'lab '+action, network:false, database:false, writes:false, wouldWrite:action==='review', readsInput:false}));
    else {
      try {
        if (action === 'compare') console.log(parts.includes('--json') ? JSON.stringify(inspectLabReview(dir),null,2) : labReviewMarkdown(dir));
        else console.log(JSON.stringify(action === 'review-template' ? reviewTemplate(dir) : appendLabReview(dir,readJson(parts[0])),null,2));
      } catch(error) { if(error instanceof LedgerError) throw error; throw new LedgerError('Lab review failed. Check the artifact paths and file permissions.'); }
    }
  } else if(args[0]==='ledger' && args[1]==='gaps') {
    const [, , dir,...flags]=args;
    if(!dir || flags.some(f=>!['--json','--dry-run'].includes(f))) throw new LedgerError('Usage: ledger gaps DIR [--json] [--dry-run]');
    if(flags.includes('--dry-run')) console.log(JSON.stringify({operation:'ledger gaps',network:false,database:false,writes:false,readsInput:false}));
    else {
      try { console.log(flags.includes('--json')?JSON.stringify(investigationGaps(dir),null,2):investigationMarkdown(dir)); }
      catch(error) { if(error instanceof LedgerError) throw error; throw new LedgerError('Cannot read investigation. Check the case path and file permissions.'); }
    }
  } else if(args[0]==='ledger') {
    const dry=args.at(-1)==='--dry-run';
    const parts=dry?args.slice(0,-1):args;
    const [,action,dir,input]=parts;
    if(!dir || !['init','append','inspect'].includes(action) || ((action==='init'||action==='append') && parts.length!==4) || (action==='inspect' && ![3,4].includes(parts.length)) || (action==='inspect' && input && !/^[a-f0-9]{64}$/.test(input))) throw new LedgerError(usage);
    if(dry) console.log(JSON.stringify({operation:'ledger '+action,network:false,database:false,writes:false,wouldWrite:action!=='inspect',readsInput:false}));
    else {
      let result;
      try {
        result=action==='init'?createCase(dir,readJson(input)):action==='append'?appendObservation(dir,readJson(input)):inspectLedger(dir,new Date(),input);
      } catch(error) { if(error instanceof LedgerError) throw error; throw new LedgerError('Ledger operation failed. Check paths, permissions and whether the case directory already exists.'); }
      console.log(JSON.stringify(result,null,2));
    }
  } else {
    const [command,file,...flags]=args;
    if(!['gaps','intake'].includes(command)||!file||flags.some(f=>!['--json','--dry-run'].includes(f))) throw Error(usage);
    if(flags.includes('--dry-run')) console.log(JSON.stringify({operation:command,network:false,database:false,writes:false,readsInput:false,output:'stdout'}));
    else {
      let input:unknown;
      try { const bytes=readFileSync(file); if(bytes.length>65536) throw Error(); input=JSON.parse(bytes.toString('utf8')); }
      catch { throw Error('Cannot read intake: use valid JSON smaller than 64 KiB.'); }
      console.log(command==='intake'?JSON.stringify(parseIntake(input),null,2):flags.includes('--json')?JSON.stringify(gaps(input),null,2):markdown(input));
    }
  }
} catch(error) { console.error(error instanceof Error?error.message:'Operation failed.'); process.exitCode=1; }
