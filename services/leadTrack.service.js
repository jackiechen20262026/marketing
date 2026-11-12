import {listStats} from './mailingStats.js';
// Preserve the existing shared lead-pool visibility. New AI and planning pages
// enforce their own narrower owner scope, and never trust model-supplied identity.
export function listLeadTrackRows(filters){return listStats({...filters,user:null});}
export default {listLeadTrackRows};
