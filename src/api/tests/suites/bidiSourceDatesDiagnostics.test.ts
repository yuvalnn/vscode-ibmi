import { Buffer } from "buffer";
import { promises as fs } from "fs";
import tmp from "tmp";
import util from "util";
import { JDBCOptions } from "@ibm/mapepire-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import IBMi from "../../IBMi";
import { Mapepire } from "../../components/mapepire";
import { Tools } from "../../Tools";
import { CONNECTION_TIMEOUT, disposeConnection, newConnection } from "../connection";

const runDiagnostics = process.env.VITE_BIDI_DIAGNOSTICS === "true";
const tmpFile = util.promisify(tmp.file);

const existingMember = {
  library: "YUVAL1",
  file: "QHEB424",
  member: "HEBREW",
  extension: "RPGLE",
};

function codePoints(value: string) {
  return [...value].map(char => `U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`);
}

function utf8Hex(value: string) {
  return Buffer.from(value, "utf8").toString("hex").toUpperCase();
}

function summarizeLines(value: string) {
  return value.split(/\r?\n/).map(line => ({
    value: line,
    codePoints: codePoints(line),
    utf8Hex: utf8Hex(line),
  }));
}

function escapeSqlString(value: string) {
  return value.replace(/'/g, "''");
}

async function timeStep<T>(timings: Record<string, number>, name: string, task: () => Promise<T>) {
  const start = Date.now();
  try {
    return await task();
  } finally {
    timings[name] = Date.now() - start;
  }
}

async function downloadMemberWithConfigSnapshot(connection: IBMi, library: string, file: string, member: string) {
  const config = connection.getConfig();
  const sourceCcsid = await connection.getFileCcsid({ library, name: file });
  const conversion = Tools.determineCcsidConversion(sourceCcsid, config);
  const value = await connection.getContent().downloadMemberContent(library, file, member);

  return {
    config: {
      sourceFileCCSID: config.sourceFileCCSID,
      sourceBidiMode: config.sourceBidiMode,
      ccsidConversionEnabled: config.ccsidConversionEnabled,
      ccsidConvertFrom: config.ccsidConvertFrom,
      ccsidConvertTo: config.ccsidConvertTo,
    },
    sourceCcsid,
    conversion,
    value,
    lines: summarizeLines(value),
  };
}

async function downloadMemberWithForcedBidiConversion(connection: IBMi, library: string, file: string, member: string) {
  const config = connection.getConfig();
  const previous = {
    ccsidConversionEnabled: config.ccsidConversionEnabled,
    ccsidConvertFrom: config.ccsidConvertFrom,
    ccsidConvertTo: config.ccsidConvertTo,
  };

  try {
    config.ccsidConversionEnabled = true;
    config.ccsidConvertFrom = "424";
    config.ccsidConvertTo = "62211";

    return await downloadMemberWithConfigSnapshot(connection, library, file, member);
  } finally {
    config.ccsidConversionEnabled = previous.ccsidConversionEnabled;
    config.ccsidConvertFrom = previous.ccsidConvertFrom;
    config.ccsidConvertTo = previous.ccsidConvertTo;
  }
}

async function simulateHebrewVisualSourceDateWrite(connection: IBMi, library: string, file: string, member: string) {
  const overFile = await connection.getContent().overDBFile(library, file, member);
  const tempTable = `QTEMP.${Tools.makeid(8)}`;

  try {
    const [columnInfo] = await connection.runSQL(
      `select ccsid, length from qsys2.syscolumns where table_schema = '${library}' and table_name = '${file}' and column_name = 'SRCDTA'`
    ) as { CCSID: number, LENGTH: number }[];

    const length = columnInfo?.LENGTH || 80;
    const visualRows = await connection.runSQL(
      `select srcseq, hex(srcdta) as ORIGINAL_HEX, cast(srcdta as varchar(${length}) ccsid 62211) as EDITOR_VALUE from ${overFile}`
    ) as { SRCSEQ: number, ORIGINAL_HEX: string, EDITOR_VALUE: string }[];

    const variants = {
      asReturned: (value: string) => value,
      trimEnd: (value: string) => value.trimEnd(),
      trimStart: (value: string) => value.trimStart(),
      trimBoth: (value: string) => value.trim(),
    };

    const results: Record<string, unknown> = {};
    for (const [variantName, transform] of Object.entries(variants)) {
      await connection.runSQL(`create or replace table ${tempTable} like "${library}"."${file}" on replace delete rows`);

      const values = visualRows.map(row =>
        `(${row.SRCSEQ}, 0, cast('${escapeSqlString(transform(row.EDITOR_VALUE))}' as varchar(${length}) ccsid 62211))`
      );

      await connection.runSQL(`insert into ${tempTable} values ${values.join(`,`)}`);

      const savedRows = await connection.runSQL(
        `select srcseq, hex(srcdta) as SAVED_HEX from ${tempTable} order by srcseq`
      ) as { SRCSEQ: number, SAVED_HEX: string }[];

      const rows = visualRows.map(row => {
        const editorValue = transform(row.EDITOR_VALUE);
        const saved = savedRows.find(savedRow => Number(savedRow.SRCSEQ) === Number(row.SRCSEQ));

        return {
          srcseq: row.SRCSEQ,
          editorValue,
          editorCodePoints: codePoints(editorValue),
          originalHex: row.ORIGINAL_HEX,
          savedHex: saved?.SAVED_HEX,
          roundTripBytesEqual: row.ORIGINAL_HEX === saved?.SAVED_HEX,
        };
      });

      results[variantName] = {
        allRoundTripBytesEqual: rows.every(row => row.roundTripBytesEqual),
        rows,
      };
    }

    return results;
  } finally {
    await connection.runSQL(`drop table if exists ${tempTable}`).catch(() => { });
    await connection.getContent().deleteOVRDBFile(overFile);
  }
}

async function simulateHebrewVisualRunSqlStmWrite(connection: IBMi, library: string, file: string, member: string) {
  const overFile = await connection.getContent().overDBFile(library, file, member);
  const tempTable = `QTEMP.${Tools.makeid(8)}`;
  const tempKey = `${library}${file}${member}BIDI`;
  const tempRemote = connection.getTempRemote(tempKey);

  if (!tempRemote) {
    throw new Error(`Could not compute temporary remote location for ${tempKey}`);
  }

  const tempRmt = Tools.ensureFullPath(tempRemote, connection.getConfig().homeDirectory);

  try {
    const [columnInfo] = await connection.runSQL(
      `select ccsid, length from qsys2.syscolumns where table_schema = '${library}' and table_name = '${file}' and column_name = 'SRCDTA'`
    ) as { CCSID: number, LENGTH: number }[];

    const length = columnInfo?.LENGTH || 80;
    const visualRows = await connection.runSQL(
      `select srcseq, hex(srcdta) as ORIGINAL_HEX, cast(srcdta as varchar(${length}) ccsid 62211) as EDITOR_VALUE from ${overFile}`
    ) as { SRCSEQ: number, ORIGINAL_HEX: string, EDITOR_VALUE: string }[];

    const variants = {
      utf8ScriptNoCast: false,
      scriptConvertedTo62211NoCast: true,
    };

    const results: Record<string, unknown> = {};
    for (const [variantName, convertScriptTo62211] of Object.entries(variants)) {
      await connection.runSQL(`drop table if exists ${tempTable}`);

      const sql = [
        `create or replace table ${tempTable} like "${library}"."${file}" on replace delete rows;`,
        `insert into ${tempTable} values ${visualRows.map(row =>
          `(${row.SRCSEQ}, 0, '${escapeSqlString(row.EDITOR_VALUE.trimEnd())}')`
        ).join(`,`)};`,
      ].join(`\n`);

      const localSql = await tmpFile();
      await fs.writeFile(localSql, sql, `utf8`);
      await connection.client!.putFile(localSql, tempRmt);

      if (connection.remoteFeatures.setccsid) {
        await connection.sendCommand({ command: `${connection.remoteFeatures.setccsid} 1208 ${tempRmt}` });
      }

      if (convertScriptTo62211) {
        await connection.runSQL(`@QSYS/CPY OBJ('${tempRmt}') TOOBJ('${tempRmt}') TOCCSID(62211) DTAFMT(*TEXT) REPLACE(*YES)`);
      }

      const runResult = await connection.runCommand({
        command: `QSYS/RUNSQLSTM SRCSTMF('${tempRmt}') COMMIT(*NONE) NAMING(*SQL)`,
        noLibList: true,
      });

      if (runResult.code !== 0) {
        results[variantName] = {
          error: runResult.stderr,
        };
        continue;
      }

      const savedRows = await connection.runSQL(
        `select srcseq, hex(srcdta) as SAVED_HEX from ${tempTable} order by srcseq`
      ) as { SRCSEQ: number, SAVED_HEX: string }[];

      const rows = visualRows.map(row => {
        const editorValue = row.EDITOR_VALUE.trimEnd();
        const saved = savedRows.find(savedRow => Number(savedRow.SRCSEQ) === Number(row.SRCSEQ));

        return {
          srcseq: row.SRCSEQ,
          editorValue,
          editorCodePoints: codePoints(editorValue),
          originalHex: row.ORIGINAL_HEX,
          savedHex: saved?.SAVED_HEX,
          roundTripBytesEqual: row.ORIGINAL_HEX === saved?.SAVED_HEX,
        };
      });

      results[variantName] = {
        allRoundTripBytesEqual: rows.every(row => row.roundTripBytesEqual),
        rows,
      };
    }

    return results;
  } finally {
    await connection.runSQL(`drop table if exists ${tempTable}`).catch(() => { });
    await connection.getContent().deleteOVRDBFile(overFile);
    await connection.clearTempRemote(tempKey).catch(() => { });
  }
}

async function readWithJdbcBidiOptions(connection: IBMi, library: string, file: string, member: string) {
  const [columnInfo] = await connection.runSQL(
    `select ccsid, length from qsys2.syscolumns where table_schema = '${library}' and table_name = '${file}' and column_name = 'SRCDTA'`
  ) as { CCSID: number, LENGTH: number }[];

  const length = columnInfo?.LENGTH || 80;
  const optionSets: Record<string, JDBCOptions> = {
    type5ImplicitFalseNumericFalse: {
      "bidi string type": "5",
      "bidi implicit reordering": false,
      "bidi numeric ordering": false,
    },
    type5ImplicitTrueNumericFalse: {
      "bidi string type": "5",
      "bidi implicit reordering": true,
      "bidi numeric ordering": false,
    },
    type5ImplicitTrueNumericTrue: {
      "bidi string type": "5",
      "bidi implicit reordering": true,
      "bidi numeric ordering": true,
    },
    type6ImplicitTrueNumericFalse: {
      "bidi string type": "6",
      "bidi implicit reordering": true,
      "bidi numeric ordering": false,
    },
    type10ImplicitTrueNumericFalse: {
      "bidi string type": "10",
      "bidi implicit reordering": true,
      "bidi numeric ordering": false,
    },
  };

  const mapepire = await connection.getComponent<Mapepire>(Mapepire.ID);
  if (!mapepire) {
    throw new Error(`Mapepire component is not available.`);
  }

  const results: Record<string, unknown> = {};
  for (const [name, jdbc] of Object.entries(optionSets)) {
    const job = await mapepire.newJob(connection, { jdbc });
    const overFile = Tools.makeid().toUpperCase();

    try {
      await job.execute(`QSYS/OVRDBF FILE(${overFile}) TOFILE(${library}/${file}) MBR(${member}) OVRSCOPE(*JOB)`, { isClCommand: true });
      const rows = await job.query(
        `select srcseq, hex(srcdta) as SRC_HEX, srcdta, cast(srcdta as varchar(${length}) ccsid 62211) as CAST_62211 from ${overFile}`
      ).execute() as { data: { SRCSEQ: number, SRC_HEX: string, SRCDTA: string, CAST_62211: string }[] };

      results[name] = {
        jdbc,
        rows: rows.data.map(row => ({
          srcseq: row.SRCSEQ,
          sourceHex: row.SRC_HEX,
          srcdta: row.SRCDTA,
          srcdtaCodePoints: codePoints(row.SRCDTA),
          cast62211: row.CAST_62211,
          cast62211CodePoints: codePoints(row.CAST_62211),
        })),
      };
    } catch (error) {
      results[name] = {
        jdbc,
        error: String(error),
      };
    } finally {
      await job.execute(`QSYS/DLTOVR FILE(${overFile}) LVL(*JOB)`, { isClCommand: true }).catch(() => { });
      await job.close();
    }
  }

  return results;
}

async function simulateJdbcBidiSourceDateRoundTrip(connection: IBMi, library: string, file: string, member: string) {
  const [columnInfo] = await connection.runSQL(
    `select ccsid, length from qsys2.syscolumns where table_schema = '${library}' and table_name = '${file}' and column_name = 'SRCDTA'`
  ) as { CCSID: number, LENGTH: number }[];

  const length = columnInfo?.LENGTH || 80;
  const jdbc: JDBCOptions = {
    "bidi string type": "5",
    "bidi implicit reordering": true,
    "bidi numeric ordering": true,
  };

  const mapepire = await connection.getComponent<Mapepire>(Mapepire.ID);
  if (!mapepire) {
    throw new Error(`Mapepire component is not available.`);
  }

  const job = await mapepire.newJob(connection, { jdbc });
  const overFile = Tools.makeid().toUpperCase();
  const literalTempTable = `QTEMP.${Tools.makeid().toUpperCase()}`;
  const parameterTempTable = `QTEMP.${Tools.makeid().toUpperCase()}`;

  try {
    await job.execute(`QSYS/OVRDBF FILE(${overFile}) TOFILE(${library}/${file}) MBR(${member}) OVRSCOPE(*JOB)`, { isClCommand: true });
    const visualRows = await job.query(
      `select srcseq, hex(srcdta) as ORIGINAL_HEX, srcdta as EDITOR_VALUE from ${overFile}`
    ).execute() as { data: { SRCSEQ: number, ORIGINAL_HEX: string, EDITOR_VALUE: string }[] };

    await job.query(`create or replace table ${literalTempTable} like "${library}"."${file}" on replace delete rows`).execute();

    const values = visualRows.data.map(row =>
      `(${row.SRCSEQ}, 0, '${escapeSqlString(row.EDITOR_VALUE.trimEnd())}')`
    );

    await job.query(`insert into ${literalTempTable} values ${values.join(`,`)}`).execute();

    const literalSavedRows = await job.query(
      `select srcseq, hex(srcdta) as SAVED_HEX from ${literalTempTable} order by srcseq`
    ).execute() as { data: { SRCSEQ: number, SAVED_HEX: string }[] };

    await job.query(`create or replace table ${parameterTempTable} like "${library}"."${file}" on replace delete rows`).execute();
    for (const row of visualRows.data) {
      await job.query(
        `insert into ${parameterTempTable} values (?, ?, ?)`,
        { parameters: [row.SRCSEQ, 0, row.EDITOR_VALUE.trimEnd()] }
      ).execute();
    }

    const parameterSavedRows = await job.query(
      `select srcseq, hex(srcdta) as SAVED_HEX from ${parameterTempTable} order by srcseq`
    ).execute() as { data: { SRCSEQ: number, SAVED_HEX: string }[] };

    const buildRows = (savedRows: { SRCSEQ: number, SAVED_HEX: string }[]) => visualRows.data.map(row => {
      const editorValue = row.EDITOR_VALUE.trimEnd();
      const saved = savedRows.find(savedRow => Number(savedRow.SRCSEQ) === Number(row.SRCSEQ));

      return {
        srcseq: row.SRCSEQ,
        editorValue,
        editorCodePoints: codePoints(editorValue),
        originalHex: row.ORIGINAL_HEX,
        savedHex: saved?.SAVED_HEX,
        roundTripBytesEqual: row.ORIGINAL_HEX === saved?.SAVED_HEX,
      };
    });

    const literalRows = buildRows(literalSavedRows.data);
    const parameterRows = buildRows(parameterSavedRows.data);

    return {
      jdbc,
      literalInsert: {
        allRoundTripBytesEqual: literalRows.every(row => row.roundTripBytesEqual),
        rows: literalRows,
      },
      parameterizedInsert: {
        allRoundTripBytesEqual: parameterRows.every(row => row.roundTripBytesEqual),
        rows: parameterRows,
      },
    };
  } finally {
    await job.query(`drop table if exists ${literalTempTable}`).execute().catch(() => { });
    await job.query(`drop table if exists ${parameterTempTable}`).execute().catch(() => { });
    await job.execute(`QSYS/DLTOVR FILE(${overFile}) LVL(*JOB)`, { isClCommand: true }).catch(() => { });
    await job.close();
  }
}

async function readAllRowsWithJdbcBidiOptions(connection: IBMi, library: string, file: string, member: string) {
  const jdbc: JDBCOptions = {
    "bidi string type": "5",
    "bidi implicit reordering": true,
    "bidi numeric ordering": true,
  };

  const mapepire = await connection.getComponent<Mapepire>(Mapepire.ID);
  if (!mapepire) {
    throw new Error(`Mapepire component is not available.`);
  }

  const job = await mapepire.newJob(connection, { jdbc });
  const overFile = Tools.makeid().toUpperCase();
  type SourceRow = { RRN: number, SRCSEQ: number, SRCDTA: string };

  try {
    await job.execute(`QSYS/OVRDBF FILE(${overFile}) TOFILE(${library}/${file}) MBR(${member}) OVRSCOPE(*JOB)`, { isClCommand: true });

    const rows: SourceRow[] = [];
    const chunks: { afterRrn: number, returned: number, total: number, lastRrn: number }[] = [];
    const chunkSize = 100;
    let lastRrn = 0;

    while (true) {
      const afterRrn = lastRrn;
      const result = await job.query<SourceRow>(
        `select rrn(${overFile}) as rrn, srcseq, srcdta from ${overFile} where rrn(${overFile}) > ${lastRrn} order by rrn(${overFile}) fetch first ${chunkSize} rows only`
      ).execute(chunkSize);

      if (!result.data.length) {
        chunks.push({ afterRrn, returned: 0, total: rows.length, lastRrn });
        break;
      }

      rows.push(...result.data);
      lastRrn = Number(result.data.at(-1)?.RRN || lastRrn);
      chunks.push({ afterRrn, returned: result.data.length, total: rows.length, lastRrn });

      if (result.data.length < chunkSize) {
        break;
      }
    }

    return {
      jdbc,
      rowCount: rows.length,
      chunks,
      sampleRows: rows
        .map((row, index) => ({ row, index }))
        .filter(({ index }) => [0, 1, 98, 99, 100, 101, rows.length - 2, rows.length - 1].includes(index))
        .map(({ row, index }) => ({
          sampleIndex: index,
          rrn: row.RRN,
          srcseq: row.SRCSEQ,
          value: row.SRCDTA,
          codePoints: codePoints(row.SRCDTA),
        })),
    };
  } finally {
    await job.execute(`QSYS/DLTOVR FILE(${overFile}) LVL(*JOB)`, { isClCommand: true }).catch(() => { });
    await job.close();
  }
}

async function benchmarkHebrewBidiSaveStages(connection: IBMi, library: string, file: string, member: string) {
  const jdbc: JDBCOptions = {
    "bidi string type": "5",
    "bidi implicit reordering": true,
    "bidi numeric ordering": true,
  };

  const mapepire = await connection.getComponent<Mapepire>(Mapepire.ID);
  if (!mapepire) {
    throw new Error(`Mapepire component is not available.`);
  }

  const timings: Record<string, number> = {};
  const job = await timeStep(timings, "newJobMs", () => mapepire.newJob(connection, { jdbc }));
  const overFile = Tools.makeid().toUpperCase();
  const loopTempTable = `QTEMP.${Tools.makeid().toUpperCase()}`;
  const batchTempTable = `QTEMP.${Tools.makeid().toUpperCase()}`;
  const visualRows: { SRCSEQ: number, SRCDAT: number, ORIGINAL_HEX: string, EDITOR_VALUE: string }[] = [];

  try {
    await timeStep(timings, "ovrdbfMs", () =>
      job.execute(`QSYS/OVRDBF FILE(${overFile}) TOFILE(${library}/${file}) MBR(${member}) OVRSCOPE(*JOB)`, { isClCommand: true })
    );

    await timeStep(timings, "readRowsMs", async () => {
      const chunkSize = 100;
      let lastRrn = 0;

      while (true) {
        const result = await job.query<{ RRN: number, SRCSEQ: number, SRCDAT: number, ORIGINAL_HEX: string, EDITOR_VALUE: string }>(
          `select rrn(${overFile}) as rrn, srcseq, case when locate('40',hex(srcdat)) > 0 then 0 else srcdat end as srcdat, hex(srcdta) as original_hex, srcdta as editor_value from ${overFile} where rrn(${overFile}) > ${lastRrn} order by rrn(${overFile}) fetch first ${chunkSize} rows only`
        ).execute(chunkSize);

        if (!result.data.length) {
          break;
        }

        visualRows.push(...result.data);
        lastRrn = Number(result.data.at(-1)?.RRN || lastRrn);

        if (result.data.length < chunkSize) {
          break;
        }
      }
    });

    await timeStep(timings, "createLoopTempTableMs", () =>
      job.query(`create or replace table ${loopTempTable} like "${library}"."${file}" on replace delete rows`).execute()
    );

    await timeStep(timings, "parameterLoopInsertMs", async () => {
      for (const row of visualRows) {
        await job.query(
          `insert into ${loopTempTable} values (?, ?, ?)`,
          { parameters: [row.SRCSEQ, row.SRCDAT, row.EDITOR_VALUE.trimEnd()] }
        ).execute();
      }
    });

    const loopRoundTrip = await timeStep(timings, "loopRoundTripCheckMs", async () => {
      const savedRows = await job.query<{ SRCSEQ: number, SAVED_HEX: string }>(
        `select srcseq, hex(srcdta) as saved_hex from ${loopTempTable} order by srcseq`
      ).execute(visualRows.length || 1);

      return visualRows.every(row => {
        const saved = savedRows.data.find(savedRow => Number(savedRow.SRCSEQ) === Number(row.SRCSEQ));
        return row.ORIGINAL_HEX === saved?.SAVED_HEX;
      });
    });

    let batchInsert: { supported: boolean, allRoundTripBytesEqual?: boolean, error?: string } = { supported: false };
    await timeStep(timings, "batchInsertExperimentMs", async () => {
      try {
        await job.query(`create or replace table ${batchTempTable} like "${library}"."${file}" on replace delete rows`).execute();
        const query = job.query(
          `insert into ${batchTempTable} values (?, ?, ?)`
        );

        query.addToBatch(visualRows.map(row => [row.SRCSEQ, row.SRCDAT, row.EDITOR_VALUE.trimEnd()]));
        await query.execute();
        await query.close().catch(() => { });

        const savedRows = await job.query<{ SRCSEQ: number, SAVED_HEX: string }>(
          `select srcseq, hex(srcdta) as saved_hex from ${batchTempTable} order by srcseq`
        ).execute(visualRows.length || 1);

        batchInsert = {
          supported: true,
          allRoundTripBytesEqual: visualRows.every(row => {
            const saved = savedRows.data.find(savedRow => Number(savedRow.SRCSEQ) === Number(row.SRCSEQ));
            return row.ORIGINAL_HEX === saved?.SAVED_HEX;
          }),
        };
      } catch (error) {
        batchInsert = {
          supported: false,
          error: String(error),
        };
      }
    });

    return {
      jdbc,
      rowCount: visualRows.length,
      timings,
      loopInsert: {
        allRoundTripBytesEqual: loopRoundTrip,
      },
      batchInsert,
    };
  } finally {
    await job.query(`drop table if exists ${loopTempTable}`).execute().catch(() => { });
    await job.query(`drop table if exists ${batchTempTable}`).execute().catch(() => { });
    await job.execute(`QSYS/DLTOVR FILE(${overFile}) LVL(*JOB)`, { isClCommand: true }).catch(() => { });
    await timeStep(timings, "closeJobMs", () => job.close()).catch(() => { });
  }
}

async function selectExpression(connection: IBMi, overFile: string, expression: string) {
  try {
    const rows = await connection.runSQL(
      `select srcseq, hex(srcdta) as SRC_HEX, ${expression} as VALUE from ${overFile}`
    ) as { SRCSEQ: number, SRC_HEX: string, VALUE: string }[];

    return rows.map(row => ({
      srcseq: row.SRCSEQ,
      sourceHex: row.SRC_HEX,
      value: row.VALUE,
      codePoints: codePoints(row.VALUE),
      utf8Hex: utf8Hex(row.VALUE),
    }));
  } catch (error) {
    return {
      error: String(error),
    };
  }
}

async function readSourceDateBoundary(connection: IBMi, library: string, file: string, member: string) {
  const overFile = await connection.getContent().overDBFile(library, file, member);

  try {
    const [columnInfo] = await connection.runSQL(
      `select ccsid, length from qsys2.syscolumns where table_schema = '${library}' and table_name = '${file}' and column_name = 'SRCDTA'`
    ) as { CCSID: number, LENGTH: number }[];

    const length = columnInfo?.LENGTH || 80;
    const jobInfo = await connection.runSQL(`
      select job_name, default_ccsid
        from table(qsys2.active_job_info(job_name_filter => '*', detailed_info => 'WORK'))
    `);

    const expressions = {
      srcdta: "srcdta",
      hex: "hex(srcdta)",
      cast1208: `cast(srcdta as varchar(${length}) ccsid 1208)`,
      cast62211: `cast(srcdta as varchar(${length}) ccsid 62211)`,
      cast424: `cast(srcdta as varchar(${length}) ccsid 424)`,
    };

    const expressionResults: Record<string, unknown> = {};
    for (const [name, expression] of Object.entries(expressions)) {
      expressionResults[name] = await selectExpression(connection, overFile, expression);
    }

    return {
      overFile,
      columnInfo,
      connectionCcsids: connection.getCcsids(),
      sqlJobInfo: jobInfo,
      expressions: expressionResults,
    };
  } finally {
    await connection.getContent().deleteOVRDBFile(overFile);
  }
}

describe.skipIf(!runDiagnostics)("BiDi source-date SQL boundary diagnostics", () => {
  let connection: IBMi;

  beforeAll(async () => {
    connection = await newConnection();
  }, CONNECTION_TIMEOUT);

  afterAll(async () => {
    await disposeConnection(connection);
  });

  it("reports SQL conversion boundary and CPYTOSTMF comparison for YUVAL1/QHEB424(HEBREW)", async () => {
    const content = connection.getContent();
    const { library, file, member, extension } = existingMember;
    const memberAttributes = await content.getAttributes({ library, name: file, member }, "CCSID", "DATA_SIZE", "CREATE_TIME", "MODIFY_TIME");
    const fileCcsid = await connection.getFileCcsid({ library, name: file });
    const sqlBoundary = await readSourceDateBoundary(connection, library, file, member);
    const cpyToStmfWithCurrentConfig = await downloadMemberWithConfigSnapshot(connection, library, file, member);
    const cpyToStmfWithForced424To62211 = await downloadMemberWithForcedBidiConversion(connection, library, file, member);
    const hebrewVisualSourceDateWriteSimulation = await simulateHebrewVisualSourceDateWrite(connection, library, file, member);
    const hebrewVisualRunSqlStmWriteSimulation = await simulateHebrewVisualRunSqlStmWrite(connection, library, file, member);
    const jdbcBidiOptionReads = await readWithJdbcBidiOptions(connection, library, file, member);
    const jdbcBidiSourceDateRoundTrip = await simulateJdbcBidiSourceDateRoundTrip(connection, library, file, member);

    console.log(JSON.stringify({
      source: `${library}/${file}/${member}.${extension}`,
      memberAttributes,
      fileCcsid,
      sqlBoundary,
      cpyToStmfWithCurrentConfig,
      cpyToStmfWithForced424To62211,
      hebrewVisualSourceDateWriteSimulation,
      hebrewVisualRunSqlStmWriteSimulation,
      jdbcBidiOptionReads,
      jdbcBidiSourceDateRoundTrip,
    }, undefined, 2));
  });

  it("reports Hebrew BiDi JDBC row count for source members above 100 rows", async () => {
    const { library, file, member, extension } = existingMember;
    const result = await readAllRowsWithJdbcBidiOptions(connection, library, file, member);
    const diagnostic = {
      source: `${library}/${file}/${member}.${extension}`,
      result,
    };

    await fs.writeFile(`/tmp/bidi-row-count-diagnostics.json`, JSON.stringify(diagnostic, undefined, 2), `utf8`);
    console.log(JSON.stringify(diagnostic, undefined, 2));
    expect(result.rowCount).toBeGreaterThan(100);
  });

  it("benchmarks Hebrew BiDi source-date save stages without modifying the member", async () => {
    const { library, file, member, extension } = existingMember;
    const result = await benchmarkHebrewBidiSaveStages(connection, library, file, member);
    const diagnostic = {
      source: `${library}/${file}/${member}.${extension}`,
      result,
    };

    await fs.writeFile(`/tmp/bidi-save-benchmark-diagnostics.json`, JSON.stringify(diagnostic, undefined, 2), `utf8`);
    console.log(JSON.stringify(diagnostic, undefined, 2));
    expect(result.rowCount).toBeGreaterThan(100);
    expect(result.loopInsert.allRoundTripBytesEqual).toBe(true);
  });
});
