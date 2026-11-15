"""Per-case rules for the director: what each actor may know, share and admit.

The director (director.py) is case-agnostic; everything that names a person,
document, time or amount lives here, keyed by case id.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Callable


@dataclass
class CaseRules:
    cover: dict[str, str]
    knowledge: dict[str, list[str]]
    share: dict[str, str]                      # suspect -> sharing action
    evidence_actions: dict[str, str]           # sharing action -> evidence id
    topics: dict[str, str]                     # suspect -> regex of sensitive topics
    personal_facts: dict[str, tuple[str, str]] # suspect -> two regexes an admission must match
    retractions: dict[str, str]                # suspect -> regex of a retracted admission
    presented: dict[str, str]                  # evidence id -> how it is described to an actor
    broken_cover: str                          # culprit's cover once both clues land
    confession_terms: tuple[str, str]          # a confession must match both
    early_confession: str                      # culprit may not say this before the gate
    culprit_secret_terms: str                  # nobody may say this before the confession
    sealed_twist: str                          # next-case twist, never said
    allowed_times: set[str]
    extra_times: dict[str, set[str]]
    fallback_confession: str
    fallback_secret: dict[str, str]
    fallback_share: dict[str, tuple[str, str]] # suspect -> (question regex, line)
    fallback_default: dict[str, str]
    command_help: str
    cross_lines: dict[str, Callable[[set[str]], str]]
    cross_pair: tuple[str, str]
    cross_requires: str                        # evidence id that exposes the contradiction
    cross_witness: str                         # who delivers it
    contradiction_note: str
    contradiction_event: dict[str, str]
    cross_confession_prompt: str
    cross_confession_note: str
    extra_validate: Callable[[object, str, object], None] = field(default=lambda turn, q, response: None)
    share_prompt: str = ''                     # how sharing is described in the actor prompt


def _case_01_extra(turn, q: str, response):
    if turn.sid == 'priya' and re.search(r'\bi (?:approved|authorized|signed off|gave final approval)\b', q):
        raise ValueError('Your established acts are vendor creation and scheduling, not final payment approval. Do not invent an approval claim.')
    if turn.sid == 'sam' and turn.secret_available and re.search(r'\b(?:out|away|interviewing)\b.{0,30}\b(?:tuesday night|that night|evening)\b', q):
        raise ValueError('The interview was Tuesday afternoon. You were at home overnight; do not move it to the night.')
    if turn.sid == 'sam' and response.stance == 'admit_secret' and re.search(r"(?:wasn't|was not|not|never)\s+(?:an?\s+)?(?:job\s+)?interview\b|\bjob offer\b", q):
        raise ValueError('The personal fact is a job interview, not a job offer or a supplier meeting. Admit that fact honestly.')
    for clause in re.split(r'[.!?;]\s*', q):
        if re.search(r'\b(?:payments?|transfers?)\b.{0,45}\b(?:at|exactly)\s+midnight\b', clause):
            raise ValueError('The actual transfer time is 11:52 PM, not exactly midnight.')


CASE_01 = CaseRules(
    cover={
        'sam': 'Maintains the books; does not approve new vendors. At home overnight. Avoid discussing his employment plans yet.',
        'marcus': 'Was outside the bakery late. Not ready to explain the embarrassing reason yet.',
        'priya': 'Always home asleep by 10 PM. Oversees operations. Sam maintains the ledger. Denies being in the office at midnight.',
        'elena': 'Home with her daughter that night; returned at 6 AM to open the bakery.',
        'theo': 'Remote maintenance ended at 9:10 PM. At home afterward. Network administration is not banking authorization.',
    },
    knowledge={
        'sam': ['Three payments to Northshore Supply, $16,250 each, totaling $48,750; all at 11:52 PM.'],
        'marcus': ['Priya’s office light was on around midnight. Saw her silhouette through the window; did not see any bank transfer.'],
        'priya': ['The bakery is missing $48,750 to Northshore Supply. The reported transfer time is 11:52 PM.'],
        'elena': ['Does not recognize Northshore Supply.', 'Sam reconciles the ledger; operations manages vendor setup.'],
        'theo': ['Staff should use individual banking credentials.', 'Network access cannot authorize banking purchases.'],
    },
    share={'sam': 'share_transaction_sheet', 'marcus': 'share_eyewitness'},
    evidence_actions={'share_transaction_sheet': 'transaction_sheet', 'share_eyewitness': 'eyewitness'},
    topics={
        'sam': r'\b(tuesday|job|interview|competitor|nervous|hiding|secret)\b',
        'marcus': r'\b(van|dent|repair|after hours|stay(?:ed)? late|hiding|secret)\b',
        'elena': r'\b(rent|debt|savings|payroll|hiding|secret|financial trouble)\b',
        'theo': r'\b(server|freelance|permission|personal project|hiding|secret)\b',
        'priya': r'\b(northshore|midnight|11:52|office|marcus|login|lying|lie|proof)\b',
    },
    personal_facts={
        'sam': (r'interview|looking for', r'compet(?:itor|ing|es)|another bakery|another job|elsewhere'),
        'marcus': (r'dent|damag', r'van'),
        'elena': (r'rent', r'savings|my own money|personal money'),
        'theo': (r'server', r'freelance|personal project|own project'),
    },
    retractions={
        'sam': r'(?:had?|attend(?:ed)?|went to|go to)\s+(?:\w+\s+){0,3}(?:job\s+)?interview|interview(?:ed)?\b',
        'marcus': r'dent(?:ed)?\b|damage(?:d)?\b',
        'elena': r'(?:cover(?:ed)?|pa(?:y|id))\s+(?:\w+\s+){0,3}rent',
        'theo': r'use(?:d)?\s+(?:\w+\s+){0,4}server',
    },
    presented={
        'transaction_sheet': 'Bank record: three Northshore payments, $16,250 each, all at 11:52 PM.',
        'eyewitness': 'Marcus’s account: Priya’s office light and silhouette around midnight.',
    },
    broken_cover='The cover alibi has failed. You were in the office at 11:52 PM.',
    confession_terms=(r'\bi\s+(?:created|set up|registered|scheduled)\b', r'northshore|vendor|payment'),
    early_confession=r"\b(?:i|we)(?:\s+(?:did|have|had|was|am))?\s+(?:created|registered|scheduled|forged|stole|set up)\b|\bi (?:took|transferred|moved|made)\b.{0,45}\b(?:money|funds|payments|transfers)\b|\bi was\b.{0,35}\b(?:office|bakery|there|working)\b.{0,25}\b(?:midnight|11:52)\b|\bnorthshore\b.{0,25}\bmy (?:idea|creation|vendor)|\bmy (?:scheme|shell vendor|fake vendor)\b",
    culprit_secret_terms=r'\b(?:priya|she)\s+(?:created|set up|registered)\s+(?:the\s+)?(?:northshore|shell|fake)',
    sealed_twist=r'(?:someone else|somebody else|another person).{0,30}(?:approved|authorized)|approved every payment|second signature',
    allowed_times={'10pm', '11:52pm'},
    extra_times={'elena': {'6am'}, 'theo': {'9:10pm'}},
    fallback_confession='All right. I created Northshore and scheduled those payments. I was in the office at 11:52. I can’t keep denying it.',
    fallback_secret={
        'sam': 'It was a job interview at a competitor. I was embarrassed about looking for another job, but I didn’t take the bakery’s money.',
        'marcus': 'I dented the delivery van. I stayed late trying to fix it before anyone noticed. That’s why I was there.',
        'elena': 'I covered the overdue rent with my savings. I was trying to protect the staff, not hide a theft.',
        'theo': 'I used the spare server for a freelance project without permission. That was wrong, but it wasn’t access to the bank.',
    },
    fallback_share={
        'sam': (r'\b(record|sheet|transaction|payment|bank|money|document|send)\b', 'The record shows three Northshore payments of $16,250, each at 11:52 PM. I can share that sheet with you.'),
        'marcus': (r'\b(saw|see|night|light|office|midnight|witness|where)\b', 'I saw Priya’s office light on around midnight, and her silhouette through the window. That’s what I can actually tell you.'),
    },
    fallback_default={
        'sam': 'I’m trying to help you understand the books. There are things I’m embarrassed about, but I didn’t take that money.',
        'marcus': 'I was there late, yes. Ask me about what I actually saw; I don’t know what happened inside the bank account.',
        'priya': 'I was home asleep by ten. A suspicious payment doesn’t put me in that office. What exactly are you asking me to explain?',
        'elena': 'I want the truth as much as you do. Please ask me something specific about the bakery, and I’ll tell you what I can.',
        'theo': 'I can explain the network access and my maintenance session. I can’t tell you who authorized a bank payment.',
    },
    command_help='Try “call Sam”, “show transaction sheet”, “cross-examine Priya and Marcus”, or “hint”.',
    cross_lines={
        'priya': lambda ev: 'I am always home asleep by ten. Every night. I wasn’t in that office.',
        'marcus': lambda ev: 'That’s not what I saw. Your office light was on around midnight. I saw you through the window.' if 'eyewitness' in ev else 'I was outside fixing a dent in the van. I wasn’t looking at bank accounts.',
        'sam': lambda ev: 'I was at home that night. My interview was Tuesday afternoon. Check the transaction sheet, not my job applications.',
        'elena': lambda ev: 'Home with my daughter. I opened the bakery at six the next morning. I wasn’t making midnight payments.',
        'theo': lambda ev: 'My maintenance connection ended at nine-ten. Network access doesn’t let me move money from the bakery’s bank account.',
    },
    cross_pair=('priya', 'marcus'),
    cross_requires='eyewitness',
    cross_witness='marcus',
    contradiction_note='CONTRADICTION: Priya says home by 10. Marcus saw her office light on at midnight.',
    contradiction_event={'title': 'These stories don’t add up.', 'left': 'Home asleep by 10 PM', 'right': 'Office light on at midnight'},
    cross_confession_prompt='The detective presents both the bank record at 11:52 PM and Marcus’s eyewitness statement. Explain the contradiction with your alibi.',
    cross_confession_note='Priya admits creating Northshore after the bank record and witness account are put together.',
    extra_validate=_case_01_extra,
    share_prompt='Include share_transaction_sheet when providing Sam’s bank record and share_eyewitness when giving Marcus’s account.',
)


CASE_02_TIMES = {
    '9:15pm', '10:20pm', '11:32pm', '11:43pm', '11:44pm', '11:45pm', '11:46pm', '11:47pm',
    '11:49pm', '11:50pm', '11:51pm', '11:52pm', '11:53pm', '11:54pm', '11:58pm', '12:08am',
}

CASE_02 = CaseRules(
    cover={
        'noah': 'In the kitchen making drinks during the blackout; did not see Ethan leave. Says he and Ethan never argued.',
        'maya': 'Argued with Ethan at dinner but made up; went upstairs to her room before the power went out. Denies getting any unusual message.',
        'oliver': 'Asleep upstairs; the blackout woke him; heard nothing unusual. Suggests Ethan may have moved his own money, and that others had motives.',
        'zara': 'On the rear patio on a phone call during the blackout; did not see Ethan leave. Says she and Ethan are just old friends.',
    },
    knowledge={
        'noah': ['Ethan was stressed all through dinner and had several unexplained phone calls lately.', 'Oliver went upstairs before the blackout saying he was tired.', 'The power went out at 11:47 PM and came back at 11:54 PM.'],
        'maya': ['She and Ethan argued during dinner at 9:15 PM.', 'She went upstairs at 11:43 PM.', 'Ethan sent her his account history earlier that night; she can share it with the detective if asked about Ethan’s money, messages or worries.'],
        'oliver': ['Ethan recently sold his startup stake and has money.', 'Noah owed Ethan money; Maya argued with Ethan at dinner.', 'The power went out at 11:47 PM and came back at 11:54 PM.'],
        'zara': ['She booked the house and has the host app with its smart-home log; she can share that log with the detective.', 'She heard a car start and pull away shortly after 11:50 PM.', 'She went out to the patio at 11:44 PM.'],
    },
    share={'maya': 'share_account_history', 'zara': 'share_house_log'},
    evidence_actions={'share_account_history': 'account_history', 'share_house_log': 'house_log'},
    topics={
        'noah': r'\b(money|loan|debt|owe|owed|8,?000|repa(?:y|id)|argu(?:e|ed|ment)|hiding|secret)\b',
        'maya': r'\b(message|text|texted|deleted|warn(?:ed|ing)?|told you|confid\w*|hiding|secret)\b',
        'zara': r'\b(gift|watch|present|friendship|relationship|close|hiding|secret)\b',
        'oliver': r'\b(laptop|device|computer|11:49|transfer|door|lock|asleep|sleep|lying|lie|proof|credentials?)\b',
    },
    # Word boundaries matter: "owe" must not match "power".
    personal_facts={
        'noah': (r'\b(?:borrow\w*|loans?|owe[sd]?|owing|lent)\b', r'\b(?:8,?000|money|debt|him)\b'),
        'maya': (r'\b(?:message|text(?:ed)?)\b', r'\bdelet'),
        'zara': (r'\b(?:gift|watch)\b', r'\b(?:ethan|gave|him|from)\b'),
    },
    retractions={
        'noah': r'(?:borrow(?:ed)?|owe[sd]?)\b',
        'maya': r'delet(?:e|ed)\b',
        'zara': r'(?:got|received|gave)\s+(?:\w+\s+){0,3}(?:gift|watch)',
    },
    presented={
        'account_history': 'Ethan’s account history: $25,000 sent to Ridgeline Capital Partners LLC at 11:49 PM, during the blackout.',
        'house_log': 'The smart-home log: Oliver’s MacBook Pro was online through the blackout, opened a banking session at 11:49 PM and unlocked the front door from inside at 11:51 PM.',
    },
    broken_cover='Your sleep alibi has failed. You were awake on your laptop during the blackout.',
    # Any first-person admission of moving the money or opening the door, e.g.
    # "I sent…", "I used his credentials to transfer…", "…and unlocked the door".
    confession_terms=(r"\bi\b.{0,160}\b(?:sen[dt]|send(?:ing)?|mov(?:e|ed|ing)|transferr?(?:ed|ing)?|took|take|unlock(?:ed)?|open(?:ed)?|wired?)\b", r'25,?000|money|funds|transfer|door|lock'),
    early_confession=r"\bi (?:sent|moved|transferred|took|wired)\b.{0,45}\b(?:money|25,?000|transfer|funds)\b|\bi (?:unlocked|opened)\b.{0,25}\bdoor\b|\bi was (?:awake|up|on my laptop|online)\b|\badrian\b|\blake harmony\b",
    culprit_secret_terms=r'\badrian\b|\blake harmony\b|\b(?:oliver|he)\s+(?:sent|moved|stole|took|unlocked)\b.{0,30}\b(?:money|25,?000|door)',
    sealed_twist=r'another (?:victim|account)|other (?:victim|transfer|account)|done (?:this|it) before',
    allowed_times=CASE_02_TIMES,
    extra_times={},
    fallback_confession='Fine. I sent the $25,000 from my laptop and I unlocked the door. Adrian Cole picked Ethan up — he’s at a rental near Lake Harmony. He’s alive.',
    fallback_secret={
        'noah': 'Okay. I borrowed $8,000 from Ethan and I still owe him most of it. We argued about it. That’s embarrassing — it’s not a reason to hurt him.',
        'maya': 'He texted me at 11:32: “If something happens tonight, check the account history.” I deleted it. I didn’t want another fight. I’m sorry.',
        'zara': 'Ethan gave me a watch. An expensive one. I hid it so Maya wouldn’t get the wrong idea. That’s all it was.',
    },
    fallback_share={
        'maya': (r'\b(account|bank|money|message|text|history|send|share|worried|stress)\b', 'He sent me his account history earlier tonight. Here — look at what left at 11:49, in the dark.'),
        'zara': (r'\b(log|house|app|record|lock|door|smart|camera|send|share|heard|hear|records)\b', 'I booked the house, so I have the host app. Here’s the smart-home log from tonight. And I heard a car pull away just after 11:50.'),
    },
    fallback_default={
        'noah': 'I was making drinks when it went dark. Ask me anything — I just want my friend back.',
        'maya': 'I’ll tell you what I can. Ask me something specific about Ethan.',
        'oliver': 'I was asleep. I know how that sounds, but a blackout isn’t evidence. Maybe ask Noah about the money he owed.',
        'zara': 'I was on the patio, on a call. I booked this place — ask me about the house.',
    },
    command_help='Try “call Zara”, “show the house log”, “cross-examine Oliver and Zara”, or “hint”.',
    cross_lines={
        'oliver': lambda ev: 'I was asleep upstairs. The blackout woke me. That’s all there is.',
        'zara': lambda ev: 'Then why did your laptop unlock the front door at 11:51, Oliver? It’s right there in the house log.' if 'house_log' in ev else 'I was on the patio. I heard a car pull away just after 11:50 — that’s all I know.',
        'noah': lambda ev: 'I was in the kitchen the whole time. Check the camera if you don’t believe me.',
        'maya': lambda ev: 'I was upstairs in my room. I didn’t see who went out.',
    },
    cross_pair=('oliver', 'zara'),
    cross_requires='house_log',
    cross_witness='zara',
    contradiction_note='CONTRADICTION: Oliver says he slept through it. The house log shows his laptop unlocking the front door at 11:51 PM.',
    contradiction_event={'title': 'These stories don’t add up.', 'left': 'Asleep through the blackout', 'right': 'His laptop unlocked the door at 11:51 PM'},
    cross_confession_prompt='The detective presents Ethan’s 11:49 PM transfer and the house log showing your laptop online during the blackout and unlocking the front door. Explain the contradiction with your alibi.',
    cross_confession_note='Oliver admits sending the $25,000 and unlocking the door; his accomplice Adrian Cole drove Ethan away.',
    share_prompt='Include share_account_history when Maya hands over Ethan’s account history and share_house_log when Zara hands over the smart-home log.',
)

RULES = {'case_01': CASE_01, 'case_02': CASE_02}
