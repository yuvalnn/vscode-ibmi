import fs from "fs";
import tmp from "tmp";
import util from "util";
import vscode from "vscode";
import { JDBCOptions, SQLJob } from "@ibm/mapepire-js";
import IBMi from "../../api/IBMi";
import { Mapepire } from "../../api/components/mapepire";
import { Tools } from "../../api/Tools";
import { CommandResult } from "../../api/types";
import { instance } from "../../instantiate";
import { getAliasName, SourceDateHandler } from "./sourceDateHandler";

const tmpFile = util.promisify(tmp.file);
const writeFileAsync = util.promisify(fs.writeFile);

const DEFAULT_RECORD_LENGTH = 80;
const HEBREW_CCSID = 424;
const HEBREW_VISUAL_JDBC_OPTIONS: JDBCOptions = {
  "bidi string type": "5",
  "bidi implicit reordering": true,
  "bidi numeric ordering": true,
};

export class ExtendedIBMiContent {
  constructor(readonly sourceDateHandler: SourceDateHandler) {

  }

  /**
   * Download the contents of a source member using SQL.
   * This option also stores the source dates internally.
   * @param {vscode.Uri} uri
   */
  async downloadMemberContentWithDates(uri: vscode.Uri) {
    const connection = instance.getConnection();
    if (connection) {
      const alias = getAliasName(uri);
      const { library, file, name } = connection.parserMemberPath(uri.path);

      // Query the column-specific CCSID and LENGTH for SRCDTA from SYSCOLUMNS.
      // Mapepire SQL cannot read columns with CCSID 65535, so we must cast to the job CCSID.
      const [columnInfo] = await connection.runSQL(
        `SELECT CCSID, LENGTH FROM QSYS2.SYSCOLUMNS WHERE TABLE_SCHEMA = '${library}' AND TABLE_NAME = '${file}' AND COLUMN_NAME = 'SRCDTA'`
      ) as { CCSID: number, LENGTH: number }[];

      const columnCcsid = columnInfo?.CCSID || 0;
      const columnLength = columnInfo?.LENGTH || DEFAULT_RECORD_LENGTH;

      // Cache the record length for later use (e.g., in upload operations)
      if (!this.sourceDateHandler.recordLengths.has(alias)) {
        this.sourceDateHandler.recordLengths.set(alias, columnLength);
      }

      const jobCcsid = connection.getCcsid();

      // Build the SELECT statement with conditional casts for CCSID handling.
      let srcdtaColumn: string;
      if (columnCcsid === IBMi.CCSID_NOCONVERSION) {
        console.log(`[downloadMemberContentWithDates] CCSID 65535 detected for ${library}/${file}, using CAST to CCSID ${jobCcsid}`);
        srcdtaColumn = `cast(srcdta as varchar(${columnLength}) CCSID ${jobCcsid}) as srcdta`;
      } else {
        srcdtaColumn = `srcdta`;
      }

      const rows = usesHebrewVisualSourceBidi(connection.getConfig(), columnCcsid)
        ? await this.selectSourceRowsWithHebrewVisualBidi(connection, library, file, name, srcdtaColumn)
        : await (async () => {
          const overFile = await connection.getContent().overDBFile(library, file, name);
          try {
            return await connection.runSQL(
              `select case when locate('40',hex(srcdat)) > 0 then 0 else srcdat end as srcdat, srcseq, ${srcdtaColumn} from ${overFile}`
            ) as { SRCDAT: number, SRCDTA: string, SRCSEQ: number }[];
          } finally {
            await connection.getContent().deleteOVRDBFile(overFile);
          }
        })();

      if (rows.length === 0) {
        rows.push({
          SRCDAT: 0,
          SRCDTA: ``,
          SRCSEQ: 0
        });
      }

      const sourceDates = rows.map(row => String(row.SRCDAT).padStart(6, `0`));
      const body = rows
        .map(row => row.SRCDTA.includes(`\\\t`) ? row.SRCDTA.replaceAll(`\\\t`, `\t`) : row.SRCDTA)
        .join(`\n`);
      const sequences = rows.map(row => Number(row.SRCSEQ));

      this.sourceDateHandler.baseDates.set(alias, sourceDates);
      this.sourceDateHandler.baseSource.set(alias, body);
      this.sourceDateHandler.baseSequences.set(alias, sequences);

      return body;
    }
  }

  /**
   * Determine the member record length
   */
  private async readRecordLength(connection: IBMi, alias: string, overFile: string): Promise<number> {
    let recordLenth = this.sourceDateHandler.recordLengths.get(alias);
    if (!recordLenth) {
      const [result] = await connection.runSQL(`select length(SRCDTA) as LENGTH from ${overFile} limit 1`);
      if (result) {
        recordLenth = Number(result.LENGTH);
      }
      else {
        recordLenth = DEFAULT_RECORD_LENGTH;
      }
      this.sourceDateHandler.recordLengths.set(alias, recordLenth);
    }

    return recordLenth;
  }

  private async readSourceDataColumnLength(connection: IBMi, alias: string, library: string, file: string): Promise<number> {
    let recordLength = this.sourceDateHandler.recordLengths.get(alias);
    if (!recordLength) {
      const [columnInfo] = await connection.runSQL(
        `SELECT LENGTH FROM QSYS2.SYSCOLUMNS WHERE TABLE_SCHEMA = '${library}' AND TABLE_NAME = '${file}' AND COLUMN_NAME = 'SRCDTA'`
      ) as { LENGTH: number }[];

      recordLength = Number(columnInfo?.LENGTH) || DEFAULT_RECORD_LENGTH;
      this.sourceDateHandler.recordLengths.set(alias, recordLength);
    }

    return recordLength;
  }

  /**
   * Upload to a member with source dates
   * @param {vscode.Uri} uri
   * @param {string} body
   */
  async uploadMemberContentWithDates(uri: vscode.Uri, body: string) {
    const connection = instance.getConnection();
    if (connection) {
      const config = connection.getConfig();
      const setccsid = connection.remoteFeatures.setccsid;

      const alias = getAliasName(uri);

      let sourceDates;

      if (!this.sourceDateHandler.baseSource.has(alias)) {
        await this.downloadMemberContentWithDates(uri);
      }
      sourceDates = this.sourceDateHandler.calcNewSourceDates(alias, body);

      const { library, file, name } = connection.parserMemberPath(uri.path);
      const asp = await connection.getLibraryIAsp(library);
      const memberPath = { library, name: file, member: name, asp };
      const sourceCcsid = await connection.getFileCcsid(memberPath);
      const sourceData = body.split(`\n`);
      const useHebrewVisualSourceBidi = usesHebrewVisualSourceBidi(config, sourceCcsid);
      if (useHebrewVisualSourceBidi) {
        const recordLength = await this.readSourceDataColumnLength(connection, alias, library, file);
        await this.uploadSourceRowsWithHebrewVisualBidi(connection, library, file, name, sourceData, sourceDates, recordLength);
        this.sourceDateHandler.baseSource.set(alias, body);
        this.sourceDateHandler.baseDates.set(alias, sourceDates);
        this.sourceDateHandler.baseSequences.delete(alias);
        return;
      }

      const client = connection.client!;

      const tempKey = library + file + name;
      const tempRemote = connection.getTempRemote(tempKey);
      if (!tempRemote) {
        throw new Error(`Could not compute temporary remote location for ${tempKey}`);
      }
      const tempRmt = Tools.ensureFullPath(tempRemote, config.homeDirectory);
      if (tempRmt) {
        const tmpobj = await tmpFile();

        const overFile = await connection.getContent().overDBFile(library, file, name);
        try {
          const recordLength = await this.readRecordLength(connection, alias, overFile);

          const decimalSequence = sourceData.length >= 10000;

          let rows = [],
            sequence = 0;
          for (let i = 0; i < sourceData.length; i++) {
            sequence = decimalSequence ? ((i + 1) / 100) : i + 1;
            sourceData[i] = sourceData[i].trimEnd();
            if (sourceData[i].length > recordLength) {
              sourceData[i] = sourceData[i].substring(0, recordLength);
            }

            rows.push(
              `(${sequence}, ${sourceDates[i] ? sourceDates[i].padEnd(6, `0`) : `0`}, '${escapeString(sourceData[i])}')`,
            );
          }

          //We assume the alias still exists....
          const tempTable = `QTEMP.NEWMEMBER`;
          const query: string[] = [
            `CREATE OR REPLACE TABLE ${tempTable} LIKE "${library}"."${file}" ON REPLACE DELETE ROWS;`,
          ];

          // Row length is the length of the SQL string used to insert each row
          const rowLength = recordLength + 55;
          // 450000 is just below the maxiumu length for each insert.
          const perInsert = Math.floor(400000 / rowLength);

          const rowGroups = sliceUp(rows, perInsert);
          rowGroups.forEach(rowGroup => {
            query.push(`insert into ${tempTable} values ${rowGroup.join(`,`)};`);
          });

          query.push(
            `CALL QSYS2.QCMDEXC('CLRPFM FILE(${library}/${file}) MBR(${name})');`,
            `insert into ${overFile} (select * from ${tempTable});`
          )

          await writeFileAsync(tmpobj, query.join(`\n`), `utf8`);
          await client.putFile(tmpobj, tempRmt);

          if (setccsid) {
            await connection.sendCommand({ command: `${setccsid} 1208 ${tempRmt}` });
          }

          // Fetch source file CCSID and determine if conversion is needed
          const { requiresConversion, targetCcsid } = Tools.determineCcsidConversion(sourceCcsid, config);

          let insertResult: CommandResult = { code: 0, stdout: '', stderr: '' };
          if (requiresConversion) {
            await connection.runSQL([
              `@QSYS/CPY OBJ('${tempRmt}') TOOBJ('${tempRmt}') TOCCSID(${targetCcsid}) DTAFMT(*TEXT) REPLACE(*YES)`
            ].join("\n")).catch(e => {
              insertResult.code = -1;
              insertResult.stderr = String(e);
            });
          }

          if (insertResult.code === 0) {
            insertResult = await connection.runCommand({
              command: `QSYS/RUNSQLSTM SRCSTMF('${tempRmt}') COMMIT(*NONE) NAMING(*SQL)`,
              noLibList: true
            });
          }

          if (insertResult.code !== 0) {
            throw new Error(`Failed to save member: ` + insertResult.stderr);
          }

          this.sourceDateHandler.baseSource.set(alias, body);
          this.sourceDateHandler.baseDates.set(alias, sourceDates);
          this.sourceDateHandler.baseSequences.delete(alias);
        } finally {
          await connection.getContent().deleteOVRDBFile(overFile);
          // Clean up temporary file
          await connection.clearTempRemote(tempKey);
        }
      }
    }
  }  

  private async selectSourceRowsWithHebrewVisualBidi(connection: IBMi, library: string, file: string, member: string, srcdtaColumn: string) {
    return this.withHebrewVisualSourceBidiJob(connection, library, file, member, async (job, overFile) => {
      type SourceRow = { RRN: number, SRCDAT: number, SRCDTA: string, SRCSEQ: number };
      const rows: SourceRow[] = [];
      const chunkSize = 100;
      let lastRrn = 0;

      while (true) {
        const statement = `select rrn(${overFile}) as rrn, case when locate('40',hex(srcdat)) > 0 then 0 else srcdat end as srcdat, srcseq, ${srcdtaColumn} from ${overFile} where rrn(${overFile}) > ${lastRrn} order by rrn(${overFile}) fetch first ${chunkSize} rows only`;
        connection.appendOutput(`Hebrew BiDi source read chunk: ${library}/${file}(${member}), after RRN ${lastRrn}\n`);

        const query = job.query<SourceRow>(statement);
        const result = await query.execute(chunkSize);
        await query.close().catch(() => { });

        if (!result.data.length) {
          connection.appendOutput(`Hebrew BiDi source read complete: ${rows.length} row(s) returned\n`);
          break;
        }

        rows.push(...result.data);
        lastRrn = Number(result.data.at(-1)?.RRN || lastRrn);
        connection.appendOutput(`Hebrew BiDi source read chunk returned ${result.data.length} row(s), total ${rows.length}, last RRN ${lastRrn}\n`);

        if (result.data.length < chunkSize) {
          connection.appendOutput(`Hebrew BiDi source read complete: ${rows.length} row(s) returned\n`);
          break;
        }
      }

      return rows;
    });
  }

  private async uploadSourceRowsWithHebrewVisualBidi(
    connection: IBMi,
    library: string,
    file: string,
    member: string,
    sourceData: string[],
    sourceDates: string[],
    recordLength: number
  ) {
    return this.withHebrewVisualSourceBidiJob(connection, library, file, member, async (job, overFile) => {
      const tempTable = `QTEMP.${Tools.makeid().toUpperCase()}`;
      const decimalSequence = sourceData.length >= 10000;

      try {
        await job.query(`create or replace table ${tempTable} like "${library}"."${file}" on replace delete rows`).execute();

        const insertRows: [number, number, string][] = [];
        for (let i = 0; i < sourceData.length; i++) {
          const sequence = decimalSequence ? ((i + 1) / 100) : i + 1;
          let sourceLine = sourceData[i].trimEnd();
          if (sourceLine.length > recordLength) {
            sourceLine = sourceLine.substring(0, recordLength);
          }

          insertRows.push([sequence, Number(sourceDates[i] ? sourceDates[i].padEnd(6, `0`) : `0`), sourceLine]);
        }

        const insertStatement = `insert into ${tempTable} values (?, ?, ?)`;
        const insertQuery = job.query(insertStatement);
        try {
          insertQuery.addToBatch(insertRows);
          await insertQuery.execute();
        } catch {
          for (const row of insertRows) {
            await job.query(insertStatement, { parameters: row }).execute();
          }
        } finally {
          await insertQuery.close().catch(() => { });
        }

        await job.query(`CALL QSYS2.QCMDEXC('CLRPFM FILE(${library}/${file}) MBR(${member})')`).execute();
        await job.query(`insert into ${overFile} (select * from ${tempTable})`).execute();
      } finally {
        await job.query(`drop table if exists ${tempTable}`).execute().catch(() => { });
      }
    });
  }

  private async withHebrewVisualSourceBidiJob<T>(
    connection: IBMi,
    library: string,
    file: string,
    member: string,
    callback: (job: SQLJob, overFile: string) => Promise<T>
  ): Promise<T> {
    const mapepire = await connection.getComponent<Mapepire>(Mapepire.ID);
    if (!mapepire) {
      throw new Error(`Mapepire component is not available.`);
    }

    const job = await mapepire.newJob(connection, { jdbc: HEBREW_VISUAL_JDBC_OPTIONS });
    const overFile = Tools.makeid().toUpperCase();

    try {
      await job.execute(`QSYS/OVRDBF FILE(${overFile}) TOFILE(${library}/${file}) MBR(${member}) OVRSCOPE(*JOB)`, { isClCommand: true });
      return await callback(job, overFile);
    } finally {
      await job.execute(`QSYS/DLTOVR FILE(${overFile}) LVL(*JOB)`, { isClCommand: true }).catch(() => { });
      await job.close();
    }
  }
}

function sliceUp(arr: any[], size: number): any[] {
  const result = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}

function usesHebrewVisualSourceBidi(config: { sourceBidiMode?: string }, sourceCcsid: number): boolean {
  return sourceCcsid === HEBREW_CCSID && (config.sourceBidiMode === `hebrewVisual` || config.sourceBidiMode === `auto`);
}

function escapeString(val: string): string {
  val = val.replace(/[\0\n\r\b\t'\x1a]/g, function (s) {
    switch (s) {
      case `\0`:
        return `\\0`;
      case `\n`:
        return `\\n`;
      case `\r`:
        return ``;
      case `\b`:
        return `\\b`;
      case `\x1a`:
        return `\\Z`;
      case `'`:
        return `''`;
      default:
        return `\\` + s;
    }
  });

  return val;
}
